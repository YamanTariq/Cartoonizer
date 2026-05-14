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
    // Spans intervals perfectly from endpoints (e.g., Level 2 maps directly to 0 and 255)
    const step = 255 / (safeLevels - 1);
    const lut = new cv.Mat(1, 256, cv.CV_8UC1);

    for (let i = 0; i < 256; i += 1) {
      lut.data[i] = clamp(Math.round(i / step) * step);
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
    const quantizedMat = new cv.Mat();
    const grayMat = new cv.Mat();
    const edgesMat = new cv.Mat();
    const edgesRgb = new cv.Mat();
    const finalDst = new cv.Mat();

    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
    const borderValue =
      typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();

    try {
      // 1. Prepare Base Colors & Edge-Preserving Smoothing
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB);
      const smoothingPasses =
        settings.cartoonSmoothingMode === 'lut-only' ? 0 : settings.cartoonSmoothingMode === 'single-bilateral' ? 1 : 2;
      
      edgePreservingSmooth(cv, rgbMat, smoothMat, settings.bilateralDiameter, 30, smoothingPasses);

      // 2. HSV Vibrance Boost (Injects 40% extra saturation pop safely in place)
      boostColor(cv, smoothMat, smoothMat, 1.4, 1.05, 0);

      // 3. Dynamic Content-Aware Color Quantization (K-Means Clustering)
      // Replaces uniform LUT mapping to group smooth wall shadows into flat solid segments
      applyKMeansQuantization(cv, smoothMat, quantizedMat, settings.colorQuantization);

      // 4. Optimized Single-Pass Edge Detection
      cv.cvtColor(rgbMat, grayMat, cv.COLOR_RGB2GRAY);
      cv.medianBlur(grayMat, grayMat, 5);

      const edgeIntensity = clamp(Math.round(settings.edgeIntensity), 1, 12);
      const adaptiveBlockSize = oddKernel(settings.bilateralDiameter + settings.edgeBlockSize * 2 + 5, 9);
      const adaptiveC = clamp(11 - edgeIntensity, 2, 10);

      cv.adaptiveThreshold(
        grayMat,
        edgesMat,
        255,
        cv.ADAPTIVE_THRESH_MEAN_C,
        cv.THRESH_BINARY_INV,
        adaptiveBlockSize,
        adaptiveC,
      );

      // 5. Thicken Outlines (Skip operation entirely if slider is set to 1px)
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

      // 6. Invert to black ink on white background and merge
      cv.bitwise_not(edgesMat, edgesMat);
      cv.cvtColor(edgesMat, edgesRgb, cv.COLOR_GRAY2RGB);
      cv.bitwise_and(quantizedMat, edgesRgb, finalDst);

      return matToRgba(cv, finalDst);
    } finally {
      // Perfectly aligned cleanup array prevents WebAssembly garbage collection crashes
      deleteMats(
        rgbMat,
        smoothMat,
        quantizedMat,
        grayMat,
        edgesMat,
        edgesRgb,
        finalDst,
        kernel,
      );
    }
  }

// function applyAdvancedPencil(cv, src, settings) {
//     const grayMat = new cv.Mat();
//     const invertedMat = new cv.Mat();
//     const blurredMat = new cv.Mat();
//     const invertedBlurredMat = new cv.Mat();
//     const finalDst = new cv.Mat();

//     try {
//       const blurStrength = Math.max(1, Math.round(settings.bilateralDiameter || 5));
//       const ksize = oddKernel(blurStrength * 4 + 1, 5);

//       cv.cvtColor(src, grayMat, cv.COLOR_RGBA2GRAY);
//       cv.bitwise_not(grayMat, invertedMat);
//       cv.GaussianBlur(invertedMat, blurredMat, new cv.Size(ksize, ksize), 0, 0, cv.BORDER_DEFAULT);
//       cv.bitwise_not(blurredMat, invertedBlurredMat);
//       cv.divide(grayMat, invertedBlurredMat, finalDst, 256.0);

//       return matToRgba(cv, finalDst);
//     } finally {
//       deleteMats(grayMat, invertedMat, blurredMat, invertedBlurredMat, finalDst);
//     }
//   }
function applyAdvancedPencil(cv, src, settings) {
    const grayMat = new cv.Mat();
    const invertedMat = new cv.Mat();
    const blurredMat = new cv.Mat();
    const invertedBlurredMat = new cv.Mat();
    const baseSketch = new cv.Mat();
    const edgesMat = new cv.Mat();
    const finalDst = new cv.Mat();

    try {
      const blurStrength = Math.max(1, Math.round(settings.bilateralDiameter || 9));
      const ksize = oddKernel(blurStrength * 4 + 1, 5);

      // Generate Color Dodge soft base tone
      cv.cvtColor(src, grayMat, cv.COLOR_RGBA2GRAY);
      cv.bitwise_not(grayMat, invertedMat);
      cv.GaussianBlur(invertedMat, blurredMat, new cv.Size(ksize, ksize), 0, 0, cv.BORDER_DEFAULT);
      cv.bitwise_not(blurredMat, invertedBlurredMat);
      cv.divide(grayMat, invertedBlurredMat, baseSketch, 256.0);

      // Extract structural outlines
      const edgeBlockSize = oddKernel(blurStrength * 2 + 3, 9);
      cv.adaptiveThreshold(
        grayMat,
        edgesMat,
        255,
        cv.ADAPTIVE_THRESH_MEAN_C,
        cv.THRESH_BINARY_INV,
        edgeBlockSize,
        5
      );

      // Overlay dark outlines directly onto the soft sketch base
      finalDst.create(src.rows, src.cols, cv.CV_8UC1);
      const sketchData = baseSketch.data;
      const edgeData = edgesMat.data;
      const outData = finalDst.data;

      for (let i = 0; i < outData.length; i += 1) {
        outData[i] = edgeData[i] > 0 ? clamp(sketchData[i] * 0.25) : sketchData[i];
      }

      return matToRgba(cv, finalDst);
    } finally {
      deleteMats(grayMat, invertedMat, blurredMat, invertedBlurredMat, baseSketch, edgesMat, finalDst);
    }
  }


function applyGlobalHatching(cv, srcRgba, targetRgba) {
    const grayMat = new cv.Mat();
    try {
      // 1. Extract true scene luminance from the raw input frame
      cv.cvtColor(srcRgba, grayMat, cv.COLOR_RGBA2GRAY);
      
      const rows = targetRgba.rows;
      const cols = targetRgba.cols;
      const lumData = grayMat.data;
      const targetData = targetRgba.data;

      // Configure your procedural pencil grid metrics
      const hatchSpacing = 5;     // Distance between strokes
      const hatchThickness = 1;   // Stroke line width

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const idx = r * cols + c;
          const luminance = lumData[idx];

          // Diagonal coordinate intersection math
          const isPrimaryStroke = (r + c) % hatchSpacing < hatchThickness;
          const isSecondaryStroke = (r - c + cols) % hatchSpacing < hatchThickness;

          let shadeFactor = 1.0;

          // Map shading density based on real-world illumination thresholds
          if (luminance < 95) {
            // Deep shadows: Intersecting grid pattern
            if (isPrimaryStroke || isSecondaryStroke) {
              shadeFactor = 0.65;
            }
          } else if (luminance < 165) {
            // Mid-tones: Single-directional parallel lines
            if (isPrimaryStroke) {
              shadeFactor = 0.82;
            }
          }

          // Directly attenuate RGB channels in-place (skipping Alpha at offset +3)
          if (shadeFactor < 1.0) {
            const pIdx = idx * 4;
            targetData[pIdx] = clamp(targetData[pIdx] * shadeFactor);
            targetData[pIdx + 1] = clamp(targetData[pIdx + 1] * shadeFactor);
            targetData[pIdx + 2] = clamp(targetData[pIdx + 2] * shadeFactor);
          }
        }
      }
    } finally {
      deleteMats(grayMat);
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

function applyKMeansQuantization(cv, src, dst, kLevels) {
    const safeK = clamp(Math.round(kLevels), 2, 32);
    dst.create(src.rows, src.cols, cv.CV_8UC3);

    // 1. Shrink image to extract representative color samples instantly
    const sampleMat = new cv.Mat();
    try {
      cv.resize(src, sampleMat, new cv.Size(80, 80), 0, 0, cv.INTER_AREA);
      const sampleData = sampleMat.data;
      const numSamples = sampleData.length / 3;

      // 2. Initialize K centroids evenly across the sample pool
      const centroids = [];
      const step = Math.max(1, Math.floor(numSamples / safeK));
      for (let i = 0; i < safeK; i += 1) {
        const idx = i * step * 3;
        centroids.push({
          r: sampleData[idx],
          g: sampleData[idx + 1],
          b: sampleData[idx + 2],
        });
      }

      // 3. Run a lightweight K-Means loop (5 iterations ensures strong convergence)
      const maxIterations = 5;
      for (let iter = 0; iter < maxIterations; iter += 1) {
        const sums = Array(safeK).fill(0).map(() => ({ r: 0, g: 0, b: 0, count: 0 }));

        for (let i = 0; i < sampleData.length; i += 3) {
          const r = sampleData[i];
          const g = sampleData[i + 1];
          const b = sampleData[i + 2];

          let minDist = Infinity;
          let bestCluster = 0;
          for (let c = 0; c < safeK; c += 1) {
            const cent = centroids[c];
            const dist = (r - cent.r) * (r - cent.r) + (g - cent.g) * (g - cent.g) + (b - cent.b) * (b - cent.b);
            if (dist < minDist) {
              minDist = dist;
              bestCluster = c;
            }
          }

          sums[bestCluster].r += r;
          sums[bestCluster].g += g;
          sums[bestCluster].b += b;
          sums[bestCluster].count += 1;
        }

        // Update centroids to their new center of mass
        for (let c = 0; c < safeK; c += 1) {
          if (sums[c].count > 0) {
            centroids[c].r = sums[c].r / sums[c].count;
            centroids[c].g = sums[c].g / sums[c].count;
            centroids[c].b = sums[c].b / sums[c].count;
          }
        }
      }

      // 4. Map the full smoothed source image directly to the converged centroids
      const inputData = src.data;
      const outputData = dst.data;

      for (let i = 0; i < inputData.length; i += 3) {
        const r = inputData[i];
        const g = inputData[i + 1];
        const b = inputData[i + 2];

        let minDist = Infinity;
        let bestCentroid = centroids[0];

        for (let c = 0; c < safeK; c += 1) {
          const cent = centroids[c];
          const dist = (r - cent.r) * (r - cent.r) + (g - cent.g) * (g - cent.g) + (b - cent.b) * (b - cent.b);
          if (dist < minDist) {
            minDist = dist;
            bestCentroid = cent;
          }
        }

        outputData[i] = clamp(Math.round(bestCentroid.r));
        outputData[i + 1] = clamp(Math.round(bestCentroid.g));
        outputData[i + 2] = clamp(Math.round(bestCentroid.b));
      }
    } finally {
      deleteMats(sampleMat);
    }
  }


function applyFilter(cv, src, settings) {
    let result;

    // 1. Generate base filter graphics
    if (settings.mode === 'pencil') {
      result = applyAdvancedPencil(cv, src, settings);
    } else if (settings.mode === 'popart') {
      result = applyPopArt(cv, src, settings);
    } else {
      result = applyProCartoon(cv, src, settings);
    }

    // 2. Stamp the dynamic directional shading grid globally
    applyGlobalHatching(cv, src, result);

    return result;
  }


  globalScope.CartoonifierFilters = {
    applyFilter,
    deleteMats,
  };
})(self);
