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
    const smoothGrayMat = new cv.Mat();
    const originalGrayMat = new cv.Mat();
    const detailGrayMat = new cv.Mat();
    const smoothEdgesMat = new cv.Mat();
    const detailEdgesMat = new cv.Mat();
    const adaptiveEdgesMat = new cv.Mat();
    const combinedEdgesMat = new cv.Mat();
    const edgesRgb = new cv.Mat();
    const finalDst = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
    const lut = createPosterizationLut(cv, settings.colorQuantization);
    const borderValue =
      typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();

    try {
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB);
      const smoothingPasses =
        settings.cartoonSmoothingMode === 'lut-only' ? 0 : settings.cartoonSmoothingMode === 'single-bilateral' ? 1 : 2;
      edgePreservingSmooth(cv, rgbMat, smoothMat, settings.bilateralDiameter, 30, smoothingPasses);
      applyPosterizationLut(cv, smoothMat, lut, posterizedMat);

      cv.cvtColor(smoothMat, smoothGrayMat, cv.COLOR_RGB2GRAY);
      cv.cvtColor(rgbMat, originalGrayMat, cv.COLOR_RGB2GRAY);
      cv.medianBlur(originalGrayMat, detailGrayMat, 3);

      const edgeIntensity = clamp(Math.round(settings.edgeIntensity), 1, 12);
      const smoothLow = clamp(82 - edgeIntensity * 6, 18, 72);
      const detailLow = clamp(58 - edgeIntensity * 4, 14, 48);
      const adaptiveBlockSize = oddKernel(settings.bilateralDiameter + settings.edgeBlockSize * 2 + 5, 9);
      const adaptiveC = clamp(11 - edgeIntensity, 2, 10);

      cv.Canny(smoothGrayMat, smoothEdgesMat, smoothLow, smoothLow * 2.35, 3, false);
      cv.Canny(detailGrayMat, detailEdgesMat, detailLow, detailLow * 2.15, 3, false);
      cv.adaptiveThreshold(
        detailGrayMat,
        adaptiveEdgesMat,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        adaptiveBlockSize,
        adaptiveC,
      );

      cv.bitwise_or(smoothEdgesMat, detailEdgesMat, combinedEdgesMat);
      cv.bitwise_or(combinedEdgesMat, adaptiveEdgesMat, combinedEdgesMat);
      cv.dilate(
        combinedEdgesMat,
        combinedEdgesMat,
        kernel,
        new cv.Point(-1, -1),
        1,
        cv.BORDER_CONSTANT,
        borderValue,
      );

      cv.bitwise_not(combinedEdgesMat, combinedEdgesMat);
      cv.cvtColor(combinedEdgesMat, edgesRgb, cv.COLOR_GRAY2RGB);
      cv.bitwise_and(posterizedMat, edgesRgb, finalDst);

      return matToRgba(cv, finalDst);
    } finally {
      deleteMats(
        rgbMat,
        smoothMat,
        posterizedMat,
        smoothGrayMat,
        originalGrayMat,
        detailGrayMat,
        smoothEdgesMat,
        detailEdgesMat,
        adaptiveEdgesMat,
        combinedEdgesMat,
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
      const blurStrength = Math.max(1, Math.round(settings.bilateralDiameter));
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

  function boostColor(cv, src, saturationScale, valueScale, valueOffset) {
    const hsv = new cv.Mat();
    const dst = new cv.Mat();

    try {
      cv.cvtColor(src, hsv, cv.COLOR_RGB2HSV);
      const data = hsv.data;

      for (let i = 0; i < data.length; i += 3) {
        data[i + 1] = clamp(data[i + 1] * saturationScale);
        data[i + 2] = clamp(data[i + 2] * valueScale + valueOffset);
      }

      cv.cvtColor(hsv, dst, cv.COLOR_HSV2RGB);
      return dst;
    } finally {
      deleteMats(hsv);
    }
  }

  function posterizeColors(cv, src, levels) {
    const safeLevels = clamp(Math.round(levels), 2, 32);
    const dst = new cv.Mat(src.rows, src.cols, cv.CV_8UC3);
    const step = 255 / (safeLevels - 1);
    const input = src.data;
    const output = dst.data;

    for (let i = 0; i < input.length; i += 3) {
      output[i] = clamp(Math.round(input[i] / step) * step);
      output[i + 1] = clamp(Math.round(input[i + 1] / step) * step);
      output[i + 2] = clamp(Math.round(input[i + 2] / step) * step);
    }

    return dst;
  }

  function overlayInk(cv, color, whiteEdgeMask, strength = 1) {
    const dst = new cv.Mat(color.rows, color.cols, cv.CV_8UC3);
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

    return dst;
  }

  function applyPopArt(cv, src, settings) {
    const rgb = new cv.Mat();
    const smooth = new cv.Mat();
    const gray = new cv.Mat();
    const edges = new cv.Mat();
    const whiteLineMask = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
    let boosted = null;
    let colorBase = null;
    let halftone = null;
    let pop = null;

    try {
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      edgePreservingSmooth(cv, rgb, smooth, 8, 24);
      boosted = boostColor(cv, smooth, 1.35, 0.9, -10);
      colorBase = posterizeColors(cv, boosted, clamp(Math.round(settings.colorQuantization / 3), 3, 10));
      halftone = new cv.Mat();
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
      pop = overlayInk(cv, halftone, whiteLineMask, 1.0);

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
