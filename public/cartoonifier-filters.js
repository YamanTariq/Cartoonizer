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

  function edgePreservingSmooth(cv, src, dst, spatialRadius, colorRadius, passCount = 2) {
    if (passCount <= 0) {
      src.copyTo(dst);
      return;
    }
    const smallWidth = Math.max(1, Math.floor(src.cols * 0.5));
    const smallHeight = Math.max(1, Math.floor(src.rows * 0.5));
    const smallSrc = new cv.Mat();
    const smallDst = new cv.Mat();
    const temp = new cv.Mat();

    try {
      cv.resize(src, smallSrc, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_LINEAR);
      const diameter = oddKernel(spatialRadius, 5);
      const sigmaColor = Math.max(35, colorRadius * 2.4);
      const sigmaSpace = Math.max(16, spatialRadius * 2.2);

      if (passCount === 1) {
        cv.bilateralFilter(smallSrc, smallDst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
      } else {
        cv.bilateralFilter(smallSrc, temp, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
        cv.bilateralFilter(temp, smallDst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
      }
      cv.resize(smallDst, dst, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
    } finally {
      deleteMats(smallSrc, smallDst, temp);
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

  function applyKMeansQuantization(cv, src, dst, kLevels) {
    const safeK = clamp(Math.round(kLevels), 2, 32);
    dst.create(src.rows, src.cols, cv.CV_8UC3);
    const sampleMat = new cv.Mat();
    try {
      cv.resize(src, sampleMat, new cv.Size(80, 80), 0, 0, cv.INTER_AREA);
      const sampleData = sampleMat.data;
      const numSamples = sampleData.length / 3;
      const centroids = [];
      const step = Math.max(1, Math.floor(numSamples / safeK));
      for (let i = 0; i < safeK; i += 1) {
        const idx = i * step * 3;
        centroids.push({ r: sampleData[idx], g: sampleData[idx + 1], b: sampleData[idx + 2] });
      }

      for (let iter = 0; iter < 5; iter += 1) {
        const sums = Array(safeK).fill(0).map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
        for (let i = 0; i < sampleData.length; i += 3) {
          const r = sampleData[i], g = sampleData[i + 1], b = sampleData[i + 2];
          let minDist = Infinity, bestCluster = 0;
          for (let c = 0; c < safeK; c += 1) {
            const cent = centroids[c];
            const dist = (r - cent.r) * (r - cent.r) + (g - cent.g) * (g - cent.g) + (b - cent.b) * (b - cent.b);
            if (dist < minDist) { minDist = dist; bestCluster = c; }
          }
          sums[bestCluster].r += r; sums[bestCluster].g += g; sums[bestCluster].b += b;
          sums[bestCluster].count += 1;
        }
        for (let c = 0; c < safeK; c += 1) {
          if (sums[c].count > 0) {
            centroids[c].r = sums[c].r / sums[c].count;
            centroids[c].g = sums[c].g / sums[c].count;
            centroids[c].b = sums[c].b / sums[c].count;
          }
        }
      }

      const inputData = src.data, outputData = dst.data;
      for (let i = 0; i < inputData.length; i += 3) {
        const r = inputData[i], g = inputData[i + 1], b = inputData[i + 2];
        let minDist = Infinity, bestCentroid = centroids[0];
        for (let c = 0; c < safeK; c += 1) {
          const cent = centroids[c];
          const dist = (r - cent.r) * (r - cent.r) + (g - cent.g) * (g - cent.g) + (b - cent.b) * (b - cent.b);
          if (dist < minDist) { minDist = dist; bestCentroid = cent; }
        }
        outputData[i] = clamp(Math.round(bestCentroid.r));
        outputData[i + 1] = clamp(Math.round(bestCentroid.g));
        outputData[i + 2] = clamp(Math.round(bestCentroid.b));
      }
    } finally {
      deleteMats(sampleMat);
    }
  }

  function applyGlobalHatching(cv, srcRgba, targetRgba) {
    const grayMat = new cv.Mat();
    try {
      cv.cvtColor(srcRgba, grayMat, cv.COLOR_RGBA2GRAY);
      const rows = targetRgba.rows, cols = targetRgba.cols;
      const lumData = grayMat.data, targetData = targetRgba.data;
      const hatchSpacing = 5, hatchThickness = 1;

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const idx = r * cols + c;
          const luminance = lumData[idx];
          const isPrimaryStroke = (r + c) % hatchSpacing < hatchThickness;
          const isSecondaryStroke = (r - c + cols) % hatchSpacing < hatchThickness;
          let shadeFactor = 1.0;

          if (luminance < 95) {
            if (isPrimaryStroke || isSecondaryStroke) shadeFactor = 0.65;
          } else if (luminance < 165) {
            if (isPrimaryStroke) shadeFactor = 0.82;
          }

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

  function applyProCartoon(cv, src, settings) {
    const rgbMat = new cv.Mat(), smoothMat = new cv.Mat(), quantizedMat = new cv.Mat();
    const grayMat = new cv.Mat(), edgesMat = new cv.Mat(), edgesRgb = new cv.Mat();
    const finalDst = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
    const borderValue = typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();

    try {
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB);
      const smoothingPasses = settings.cartoonSmoothingMode === 'lut-only' ? 0 : settings.cartoonSmoothingMode === 'single-bilateral' ? 1 : 2;
      edgePreservingSmooth(cv, rgbMat, smoothMat, settings.bilateralDiameter, 30, smoothingPasses);
      boostColor(cv, smoothMat, smoothMat, 1.4, 1.05, 0);
      applyKMeansQuantization(cv, smoothMat, quantizedMat, settings.colorQuantization);

      cv.cvtColor(rgbMat, grayMat, cv.COLOR_RGB2GRAY);
      cv.medianBlur(grayMat, grayMat, 5);

      const edgeIntensity = clamp(Math.round(settings.edgeIntensity), 1, 12);
      const adaptiveBlockSize = oddKernel(settings.bilateralDiameter + settings.edgeBlockSize * 2 + 5, 9);
      const adaptiveC = clamp(11 - edgeIntensity, 2, 10);

      cv.adaptiveThreshold(grayMat, edgesMat, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, adaptiveBlockSize, adaptiveC);
      if (edgeThickness > 1) {
        cv.dilate(edgesMat, edgesMat, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, borderValue);
      }

      cv.bitwise_not(edgesMat, edgesMat);
      cv.cvtColor(edgesMat, edgesRgb, cv.COLOR_GRAY2RGB);
      cv.bitwise_and(quantizedMat, edgesRgb, finalDst);
      return matToRgba(cv, finalDst);
    } finally {
      deleteMats(rgbMat, smoothMat, quantizedMat, grayMat, edgesMat, edgesRgb, finalDst, kernel);
    }
  }

  function applyAdvancedPencil(cv, src, settings) {
    const grayMat = new cv.Mat(), invertedMat = new cv.Mat(), blurredMat = new cv.Mat();
    const invertedBlurredMat = new cv.Mat(), baseSketch = new cv.Mat(), edgesMat = new cv.Mat();
    const finalDst = new cv.Mat();

    try {
      const blurStrength = Math.max(1, Math.round(settings.bilateralDiameter || 9));
      const ksize = oddKernel(blurStrength * 4 + 1, 5);
      cv.cvtColor(src, grayMat, cv.COLOR_RGBA2GRAY);
      cv.bitwise_not(grayMat, invertedMat);
      cv.GaussianBlur(invertedMat, blurredMat, new cv.Size(ksize, ksize), 0, 0, cv.BORDER_DEFAULT);
      cv.bitwise_not(blurredMat, invertedBlurredMat);
      cv.divide(grayMat, invertedBlurredMat, baseSketch, 256.0);

      const edgeBlockSize = oddKernel(blurStrength * 2 + 3, 9);
      cv.adaptiveThreshold(grayMat, edgesMat, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, edgeBlockSize, 5);

      finalDst.create(src.rows, src.cols, cv.CV_8UC1);
      const sketchData = baseSketch.data, edgeData = edgesMat.data, outData = finalDst.data;
      for (let i = 0; i < outData.length; i += 1) {
        outData[i] = edgeData[i] > 0 ? clamp(sketchData[i] * 0.25) : sketchData[i];
      }
      return matToRgba(cv, finalDst);
    } finally {
      deleteMats(grayMat, invertedMat, blurredMat, invertedBlurredMat, baseSketch, edgesMat, finalDst);
    }
  }

  function applyPopArt(cv, src, settings) {
    const rgb = new cv.Mat(), smooth = new cv.Mat(), gray = new cv.Mat();
    const edges = new cv.Mat(), whiteLineMask = new cv.Mat(), boosted = new cv.Mat();
    const colorBase = new cv.Mat(), halftone = new cv.Mat(), pop = new cv.Mat();
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
      const base = colorBase.data, grayData = gray.data;

      for (let y = 0; y < gray.rows; y += dotSize) {
        for (let x = 0; x < gray.cols; x += dotSize) {
          const cellWidth = Math.min(dotSize, gray.cols - x);
          const cellHeight = Math.min(dotSize, gray.rows - y);
          let brightness = 0, red = 0, green = 0, blue = 0, count = 0;

          for (let yy = 0; yy < cellHeight; yy += 1) {
            for (let xx = 0; xx < cellWidth; xx += 1) {
              const pixelIndex = (y + yy) * gray.cols + x + xx;
              const colorIndex = pixelIndex * 3;
              brightness += grayData[pixelIndex];
              red += base[colorIndex]; green += base[colorIndex + 1]; blue += base[colorIndex + 2];
              count += 1;
            }
          }
          brightness /= count; red /= count; green /= count; blue /= count;
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

  // --- Optimized CPU-based Anisotropic Kuwahara Filter ---
// --- Optimized CPU-based Anisotropic Kuwahara Filter with Optional Edge Overlay ---
  function applyOilPainting(cv, src, settings) {
    const workSrc = new cv.Mat(), rgb = new cv.Mat(), gray = new cv.Mat();
    const sobelX = new cv.Mat(), sobelY = new cv.Mat();
    const jxx = new cv.Mat(), jyy = new cv.Mat(), jxy = new cv.Mat();
    const dst = new cv.Mat();
    
    // Mat containers for the optional edge overlay logic
    const edgesMat = new cv.Mat(), edgesRgb = new cv.Mat();
    let kernel = null;

    try {
      // 1. Cap internal processing resolution to guarantee fast framerates
      const targetWidth = Math.min(src.cols, 400);
      const scale = targetWidth / src.cols;
      const targetHeight = Math.max(1, Math.round(src.rows * scale));

      cv.resize(src, workSrc, new cv.Size(targetWidth, targetHeight), 0, 0, cv.INTER_AREA);
      cv.cvtColor(workSrc, rgb, cv.COLOR_RGBA2RGB);

      // Saturate paint colors slightly to enrich pigments
      boostColor(cv, rgb, rgb, 1.35, 1.05, 0);
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

      // 2. Compute Structure Tensor Gradients natively
      cv.Sobel(gray, sobelX, cv.CV_32F, 1, 0, 3);
      cv.Sobel(gray, sobelY, cv.CV_32F, 0, 1, 3);

      cv.multiply(sobelX, sobelX, jxx);
      cv.multiply(sobelY, sobelY, jyy);
      cv.multiply(sobelX, sobelY, jxy);

      // Gaussian integration smoothes the local orientation flow map
      const radius = clamp(Math.round(settings.bilateralDiameter || 5), 2, 8);
      const blurSize = oddKernel(radius + 2, 5);
      cv.GaussianBlur(jxx, jxx, new cv.Size(blurSize, blurSize), 0, 0);
      cv.GaussianBlur(jyy, jyy, new cv.Size(blurSize, blurSize), 0, 0);
      cv.GaussianBlur(jxy, jxy, new cv.Size(blurSize, blurSize), 0, 0);

      // 3. Precompute rotated directional sector offsets caching
      if (!self.__kuwaharaSectorsCache) {
        self.__kuwaharaSectorsCache = {};
      }
      const cacheKey = radius;
      if (!self.__kuwaharaSectorsCache[cacheKey]) {
        const numAngles = 16;
        const cachedAngles = [];
        for (let a = 0; a < numAngles; a += 1) {
          const phi = (a / numAngles) * Math.PI;
          const cosP = Math.cos(phi);
          const sinP = Math.sin(phi);
          const sectors = [];

          const quadrants = [
            { uMin: 0, uMax: radius, vMin: 0, vMax: radius },
            { uMin: -radius, uMax: 0, vMin: 0, vMax: radius },
            { uMin: -radius, uMax: 0, vMin: -radius, vMax: 0 },
            { uMin: 0, uMax: radius, vMin: -radius, vMax: 0 },
          ];

          for (let q = 0; q < 4; q += 1) {
            const offsets = [];
            const seen = new Set();
            const quad = quadrants[q];
            for (let v = quad.vMin; v <= quad.vMax; v += 1) {
              for (let u = quad.uMin; u <= quad.uMax; u += 1) {
                const dx = Math.round(u * cosP - v * sinP);
                const dy = Math.round(u * sinP + v * cosP);
                const key = `${dx},${dy}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  offsets.push({ dx, dy });
                }
              }
            }
            sectors.push(offsets);
          }
          cachedAngles.push(sectors);
        }
        self.__kuwaharaSectorsCache[cacheKey] = cachedAngles;
      }

      const cachedSectors = self.__kuwaharaSectorsCache[cacheKey];
      dst.create(targetHeight, targetWidth, cv.CV_8UC3);

      const srcData = rgb.data;
      const dstData = dst.data;
      const jxxData = jxx.data32F;
      const jyyData = jyy.data32F;
      const jxyData = jxy.data32F;

      const width = targetWidth;
      const height = targetHeight;
      const numAngles = 16;

      // 4. Ultra-fast Single-Pass Sector Loop
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const pIdx = y * width + x;
          const E = jxxData[pIdx];
          const G = jyyData[pIdx];
          const F = jxyData[pIdx];

          // Tangent orientation alignment (perpendicular to gradient)
          const twoTheta = Math.atan2(2 * F, E - G);
          let phi = twoTheta / 2 + Math.PI / 2;
          if (phi < 0) phi += Math.PI;
          if (phi >= Math.PI) phi -= Math.PI;

          const angleBin = Math.floor((phi / Math.PI) * numAngles) % numAngles;
          const sectors = cachedSectors[angleBin];

          let minVariance = Infinity;
          let bestR = 0, bestG = 0, bestB = 0;

          // Process the 4 directional sub-regions using single-pass variance math
          for (let s = 0; s < 4; s += 1) {
            const offsets = sectors[s];
            const len = offsets.length;
            let sumR = 0, sumG = 0, sumB = 0;
            let sumSqR = 0, sumSqG = 0, sumSqB = 0;
            let count = 0;

            for (let i = 0; i < len; i += 1) {
              const off = offsets[i];
              const sx = x + off.dx;
              const sy = y + off.dy;
              if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                const idx = (sy * width + sx) * 3;
                const r = srcData[idx], g = srcData[idx + 1], b = srcData[idx + 2];
                sumR += r; sumG += g; sumB += b;
                sumSqR += r * r; sumSqG += g * g; sumSqB += b * b;
                count += 1;
              }
            }

            if (count > 0) {
              const meanR = sumR / count;
              const meanG = sumG / count;
              const meanB = sumB / count;

              // Var = E[X^2] - (E[X])^2
              const varR = sumSqR / count - meanR * meanR;
              const varG = sumSqG / count - meanG * meanG;
              const varB = sumSqB / count - meanB * meanB;
              const totalVar = varR + varG + varB;

              if (totalVar < minVariance) {
                minVariance = totalVar;
                bestR = meanR; bestG = meanG; bestB = meanB;
              }
            }
          }

          const outIdx = pIdx * 3;
          dstData[outIdx] = bestR;
          dstData[outIdx + 1] = bestG;
          dstData[outIdx + 2] = bestB;
        }
      }

      // --- 5. Apply Optional Edge Overlay ---
      if (settings.kuwaharaEdgeOverlay) {
        // Remove surface noise from the grayscale source
        cv.medianBlur(gray, gray, 5);

        const edgeIntensity = clamp(Math.round(settings.edgeIntensity || 5), 1, 12);
        const edgeBlock = oddKernel((settings.bilateralDiameter || 5) + (settings.edgeBlockSize || 2) * 2 + 5, 9);
        const adaptiveC = clamp(11 - edgeIntensity, 2, 10);

        // Extract clean ink outlines via adaptive thresholding
        cv.adaptiveThreshold(gray, edgesMat, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, edgeBlock, adaptiveC);

        const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize || 2));
        if (edgeThickness > 1) {
          kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
          const borderValue = typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();
          cv.dilate(edgesMat, edgesMat, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, borderValue);
        }

        // Invert back to black lines on white mask, convert to RGB, and combine
        cv.bitwise_not(edgesMat, edgesMat);
        cv.cvtColor(edgesMat, edgesRgb, cv.COLOR_GRAY2RGB);
        cv.bitwise_and(dst, edgesRgb, dst);
      }

      // Smoothly upscale back to standard rendering dimensions
      cv.resize(dst, dst, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
      return matToRgba(cv, dst);
    } finally {
      deleteMats(workSrc, rgb, gray, sobelX, sobelY, jxx, jyy, jxy, dst, edgesMat, edgesRgb);
      if (kernel) deleteMats(kernel);
    }
  } 

  function applyFilter(cv, src, settings) {
    let result;
    if (settings.mode === 'pencil') {
      result = applyAdvancedPencil(cv, src, settings);
    } else if (settings.mode === 'popart') {
      result = applyPopArt(cv, src, settings);
    } else if (settings.mode === 'oilpainting') {
      result = applyOilPainting(cv, src, settings);
    } else {
      result = applyProCartoon(cv, src, settings);
    }

    // Explicitly restrict cross-hatching to cartoon/pencil lines to avoid muddying smooth oil textures
    if (settings.mode === 'cartoon' || settings.mode === 'pencil') {
      applyGlobalHatching(cv, src, result);
    }
    return result;
  }

  globalScope.CartoonifierFilters = {
    applyFilter,
    deleteMats,
  };
})(self);