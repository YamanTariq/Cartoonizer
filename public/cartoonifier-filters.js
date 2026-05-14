(function registerCartoonifierFilters(globalScope) {
  function deleteMats(...mats) {
    for (const mat of mats) {
      if (mat && typeof mat.delete === 'function') {
        mat.delete();
      }
    }
  }

  function clamp(value, min = 0, max = 255) {
    return Math.max(min, Math.min(max, value));
  }

  function oddKernel(value, min = 3) {
    const rounded = Math.max(min, Math.round(value));
    return rounded % 2 === 0 ? rounded + 1 : rounded;
  }

  function matToRgba(cv, mat) {
    const dst = new cv.Mat();

    if (mat.type() === cv.CV_8UC4) {
      mat.copyTo(dst);
    } else if (mat.type() === cv.CV_8UC3) {
      cv.cvtColor(mat, dst, cv.COLOR_RGB2RGBA);
    } else if (mat.type() === cv.CV_8UC1) {
      cv.cvtColor(mat, dst, cv.COLOR_GRAY2RGBA);
    } else {
      const converted = new cv.Mat();
      try {
        mat.convertTo(converted, cv.CV_8U);
        cv.cvtColor(converted, dst, cv.COLOR_GRAY2RGBA);
      } finally {
        deleteMats(converted);
      }
    }

    return dst;
  }

  function createPosterizationLut(cv, colorLevels) {
    const safeLevels = clamp(Math.round(colorLevels), 2, 64);
    const divisor = 256 / safeLevels;
    const lut = new cv.Mat(1, 256, cv.CV_8UC1);

    for (let i = 0; i < 256; i += 1) {
      lut.data[i] = clamp(Math.floor(i / divisor) * divisor + divisor / 2);
    }

    return lut;
  }

  function edgePreservingSmooth(cv, src, dst, spatialRadius, colorRadius, passCount = 2) {
    if (passCount <= 0) {
      src.copyTo(dst);
      return;
    }

    // 1. Calculate downscaled dimensions (50% resolution cuts pixel operations by 4x)
    const smallWidth = Math.max(1, Math.floor(src.cols * 0.5));
    const smallHeight = Math.max(1, Math.floor(src.rows * 0.5));

    const smallSrc = new cv.Mat();
    const smallDst = new cv.Mat();
    const temp = new cv.Mat();

    try {
      // 2. Downsample the source image using linear interpolation
      cv.resize(src, smallSrc, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_LINEAR);

      // 3. Derive bilateral filter parameters safely
      const diameter = oddKernel(spatialRadius, 5);
      const sigmaColor = Math.max(35, colorRadius * 2.4);
      const sigmaSpace = Math.max(16, spatialRadius * 2.2);

      // 4. Apply Bilateral Filter pass(es) on the lightweight downsampled image
      if (passCount === 1) {
        cv.bilateralFilter(smallSrc, smallDst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
      } else {
        cv.bilateralFilter(smallSrc, temp, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
        cv.bilateralFilter(temp, smallDst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
      }

      // 5. Upsample directly into the output destination matrix
      cv.resize(smallDst, dst, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
    } finally {
      // Guarantee intermediate mats are deleted to prevent WebAssembly memory crashes
      deleteMats(smallSrc, smallDst, temp);
    }
  }

  function applyPosterizationLut(cv, src, lut, dst) {
    if (typeof cv.LUT === 'function') {
      cv.LUT(src, lut, dst);
      return;
    }

    dst.create(src.rows, src.cols, src.type());
    const input = src.data;
    const output = dst.data;
    const table = lut.data;

    for (let i = 0; i < input.length; i += 1) {
      output[i] = table[input[i]];
    }
  }

  function applyProCartoon(cv, src, settings) {
    const rgbMat = new cv.Mat();
    const smoothMat = new cv.Mat();
    const posterizedMat = new cv.Mat();
    const grayMat = new cv.Mat();
    const edgesMat = new cv.Mat();
    const edgesRgb = new cv.Mat();
    const finalDst = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
    const lut = createPosterizationLut(cv, settings.colorQuantization);
    const borderValue =
      typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();

    try {
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB);

// 1. Prepare Base Colors & Smoothing
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB);
      const smoothingPasses =
        settings.cartoonSmoothingMode === 'lut-only' ? 0 : settings.cartoonSmoothingMode === 'single-bilateral' ? 1 : 2;
      edgePreservingSmooth(cv, rgbMat, smoothMat, settings.bilateralDiameter, 30, smoothingPasses);
      applyPosterizationLut(cv, smoothMat, lut, posterizedMat);

      // 2. Optimized Single-Pass Edge Detection
      cv.cvtColor(rgbMat, grayMat, cv.COLOR_RGB2GRAY);
      cv.medianBlur(grayMat, grayMat, 5); // Cleans up speckles so lines look hand-drawn

      const edgeIntensity = clamp(Math.round(settings.edgeIntensity), 1, 12);
      const adaptiveBlockSize = oddKernel(settings.bilateralDiameter + settings.edgeBlockSize * 2 + 5, 9);
      const adaptiveC = clamp(11 - edgeIntensity, 2, 10);

      // Extract bold outlines directly as white lines on black background
      cv.adaptiveThreshold(
        grayMat,
        edgesMat,
        255,
        cv.ADAPTIVE_THRESH_MEAN_C, // MEAN_C is faster and provides superior flat comic-style line weights
        cv.THRESH_BINARY_INV,
        adaptiveBlockSize,
        adaptiveC,
      );

      // 3. Thicken Ink Outlines (Skip operation entirely if slider is set to 1px)
      if (edgeThickness > 1) {
        cv.dilate(
          edgesMat,
          edgesMat,
          kernel,
          new cv.Point(-1, -1),
          1,
          cv.BORDER_CONSTANT,
          borderValue,
        );
      }

      // 4. Invert to black ink on white background and merge
      cv.bitwise_not(edgesMat, edgesMat);
      cv.cvtColor(edgesMat, edgesRgb, cv.COLOR_GRAY2RGB);
      cv.bitwise_and(posterizedMat, edgesRgb, finalDst);

      return matToRgba(cv, finalDst);

    } finally {
      deleteMats(
        rgbMat,
        smoothMat,
        posterizedMat,
        grayMat,
        edgesMat,
        edgesRgb,
        finalDst,
        kernel,
        lut,
      );
    }

  }

function applyAdvancedPencil(cv, src, settings) {
    const grayMat = new cv.Mat();
    const invertedMat = new cv.Mat();
    const blurredMat = new cv.Mat();
    const invertedBlurredMat = new cv.Mat();
    const finalDst = new cv.Mat();

    try {
      const blurStrength = Math.max(1, Math.round(settings.bilateralDiameter || 5));
      const ksize = oddKernel(blurStrength * 4 + 1, 5);

      cv.cvtColor(src, grayMat, cv.COLOR_RGBA2GRAY);
      cv.bitwise_not(grayMat, invertedMat);
      cv.GaussianBlur(invertedMat, blurredMat, new cv.Size(ksize, ksize), 0, 0, cv.BORDER_DEFAULT);
      cv.bitwise_not(blurredMat, invertedBlurredMat);
      cv.divide(grayMat, invertedBlurredMat, finalDst, 256.0);

      return matToRgba(cv, finalDst);
    } finally {
      deleteMats(grayMat, invertedMat, blurredMat, invertedBlurredMat, finalDst);
    }
  }


function boostColor(cv, src, dst, saturationScale, valueScale, valueOffset) {
    const hsv = new cv.Mat();

    try {
      cv.cvtColor(src, hsv, cv.COLOR_RGB2HSV);
      const data = hsv.data;

      for (let i = 0; i < data.length; i += 3) {
        data[i + 1] = clamp(data[i + 1] * saturationScale);
        data[i + 2] = clamp(data[i + 2] * valueScale + valueOffset);
      }

      cv.cvtColor(hsv, dst, cv.COLOR_HSV2RGB);
    } finally {
      deleteMats(hsv);
    }
  }

  function posterizeColors(cv, src, dst, levels) {
    const safeLevels = clamp(Math.round(levels), 2, 32);
    dst.create(src.rows, src.cols, cv.CV_8UC3);
    const step = 255 / (safeLevels - 1);
    const input = src.data;
    const output = dst.data;

    for (let i = 0; i < input.length; i += 3) {
      output[i] = clamp(Math.round(input[i] / step) * step);
      output[i + 1] = clamp(Math.round(input[i + 1] / step) * step);
      output[i + 2] = clamp(Math.round(input[i + 2] / step) * step);
    }
  }

  function overlayInk(cv, color, whiteEdgeMask, dst, strength = 1) {
    dst.create(color.rows, color.cols, cv.CV_8UC3);
    const colorData = color.data;
    const edgeData = whiteEdgeMask.data;
    const output = dst.data;

    for (let pixel = 0; pixel < edgeData.length; pixel += 1) {
      const colorIndex = pixel * 3;
      const ink = clamp(((255 - edgeData[pixel]) / 255) * strength, 0, 1);
      const keep = 1 - ink;
      output[colorIndex] = colorData[colorIndex] * keep;
      output[colorIndex + 1] = colorData[colorIndex + 1] * keep;
      output[colorIndex + 2] = colorData[colorIndex + 2] * keep;
    }
  }

  function applyPopArt(cv, src, settings) {
    const rgb = new cv.Mat();
    const smooth = new cv.Mat();
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const whiteLineMask = new cv.Mat();
    const boosted = new cv.Mat();
    const colorBase = new cv.Mat();
    const halftone = new cv.Mat();
    const pop = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);

    try {
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      edgePreservingSmooth(cv, rgb, smooth, 8, 24);
      boostColor(cv, smooth, boosted, 1.35, 0.9, -10);
      posterizeColors(cv, boosted, colorBase, clamp(Math.round(settings.colorQuantization / 3), 3, 10));
      colorBase.copyTo(halftone);
      cv.cvtColor(colorBase, gray, cv.COLOR_RGB2GRAY);

      const dotSize = Math.max(4, Math.round(settings.dotSize));
      const base = colorBase.data;
      const grayData = gray.data;

      for (let y = 0; y < gray.rows; y += dotSize) {
        for (let x = 0; x < gray.cols; x += dotSize) {
          const cellWidth = Math.min(dotSize, gray.cols - x);
          const cellHeight = Math.min(dotSize, gray.rows - y);
          let brightness = 0;
          let red = 0;
          let green = 0;
          let blue = 0;
          let count = 0;

          for (let yy = 0; yy < cellHeight; yy += 1) {
            for (let xx = 0; xx < cellWidth; xx += 1) {
              const pixelIndex = (y + yy) * gray.cols + x + xx;
              const colorIndex = pixelIndex * 3;
              brightness += grayData[pixelIndex];
              red += base[colorIndex];
              green += base[colorIndex + 1];
              blue += base[colorIndex + 2];
              count += 1;
            }
          }

          brightness /= count;
          red /= count;
          green /= count;
          blue /= count;

          const darkness = 1 - brightness / 255;
          const radius = Math.round(Math.pow(darkness, 0.7) * dotSize * 0.62);
          if (radius < 1) continue;

          const center = new cv.Point(Math.round(x + cellWidth / 2), Math.round(y + cellHeight / 2));
          cv.circle(halftone, center, radius, new cv.Scalar(red * 0.28, green * 0.24, blue * 0.22), -1, cv.LINE_AA);
        }
      }

      const lowThreshold = clamp(92 - settings.edgeIntensity * 6, 26, 78);
      cv.Canny(gray, edges, lowThreshold, lowThreshold * 2.2, 3, false);
      cv.dilate(edges, edges, kernel);
      cv.bitwise_not(edges, whiteLineMask);
      overlayInk(cv, halftone, whiteLineMask, pop, 1.0);

      return matToRgba(cv, pop);
    } finally {
      deleteMats(rgb, smooth, gray, edges, whiteLineMask, kernel, boosted, colorBase, halftone, pop);
    }
  }


  function applyFilter(cv, src, settings) {
    if (settings.mode === 'pencil') {
      return applyAdvancedPencil(cv, src, settings);
    }

    if (settings.mode === 'popart') {
      return applyPopArt(cv, src, settings);
    }

    return applyProCartoon(cv, src, settings);
  }

  globalScope.CartoonifierFilters = {
    applyFilter,
    deleteMats,
  };
})(self);
