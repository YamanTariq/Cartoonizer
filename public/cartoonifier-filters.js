(function registerCartoonifierFilters(globalScope) {

  // need to free memory allocated by opencv since
  // it's c++ compiled to wasm so no garbage collector
  // need to free ourserlves for that reason

  function deleteMats(...mats) { // REST operator
    for (const mat of mats) {

      // check if null/undefined AND object if object has a function called delete 
      if (mat && typeof mat.delete === 'function') { // short circuit eval
        mat.delete();
      }
    }
  }

  // min and max are default parameters for ease of use
  function clamp(value, min = 0, max = 255) {
    return Math.max(min, Math.min(max, value)); // ensure value is within 0 to 255
  }

  //force the kernel size to be Odd no matter the user input
  function oddKernel(value, min = 3) {
    const rounded = Math.max(min, Math.round(value));
    return rounded % 2 === 0 ? rounded + 1 : rounded;
  }

  // convert <format> to RGBA since canvas only takes RGBA
  function matToRgba(cv, mat) {
    const dst = new cv.Mat();
    if (mat.type() === cv.CV_8UC4) { // 8 bit, 4 channels (RGBA)
      mat.copyTo(dst);
    } else if (mat.type() === cv.CV_8UC3) { //8 bit, 3 channels (RGB)
      cv.cvtColor(mat, dst, cv.COLOR_RGB2RGBA);
    } else if (mat.type() === cv.CV_8UC1) { // 8 bits, 1 channel (Grey scale)
      cv.cvtColor(mat, dst, cv.COLOR_GRAY2RGBA);
    } else {
      const converted = new cv.Mat();
      try {
        mat.convertTo(converted, cv.CV_8U); //force convert to 8-bit
        cv.cvtColor(converted, dst, cv.COLOR_GRAY2RGBA); //convert to rgba
      } finally {
        deleteMats(converted);
      }
    }
    return dst;
  }

  //apply bilateral filter: edge preserving, noise-removing smoothing filter
  // checks [1] space: how close pixels are and [2] color: how similar are colors
  function edgePreservingSmooth(cv, src, dst, spatialRadius, colorRadius, passCount = 2) {
    if (passCount <= 0) {
      src.copyTo(dst);
      return;
    }
    // Down-sample the image to half size since bilateral filter is mathematically expensive
    // we calculate the width and height of the smaller image first
    const smallWidth = Math.max(1, Math.floor(src.cols * 0.5));  //can't be less than 1
    const smallHeight = Math.max(1, Math.floor(src.rows * 0.5)); //can't be less than 1
    const smallSrc = new cv.Mat();
    const smallDst = new cv.Mat();
    const temp = new cv.Mat();

    try {
      //bilinear interpolation used because it's fast and gives good results
      // calculates 2x2 matrix, finds average color and creates new result pixel
      //       src      dest        dimentions       scale factors:  fx fy  
      cv.resize(src, smallSrc, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_LINEAR); // perform bilinear interpolation

      const diameter = oddKernel(spatialRadius, 5); // make sure kernel size is odd
      const sigmaColor = Math.max(35, colorRadius * 2.4); // larger value means more bluring of different colors, small value means less blur or diff color
      const sigmaSpace = Math.max(16, spatialRadius * 2.2); // larger= far away pixel also affect center, small= less affect center

      if (passCount === 1) {
        //single bilateralFilter is more performative but gives less smooth textures
        //                  src        dest      kernel                           also handle border pixels
        cv.bilateralFilter(smallSrc, smallDst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
      } else {
        // double BilateralFilter is compute heavy but gives perfect flat texture
        cv.bilateralFilter(smallSrc, temp, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
        cv.bilateralFilter(temp, smallDst, diameter, sigmaColor, sigmaSpace, cv.BORDER_DEFAULT);
      }
      cv.resize(smallDst, dst, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
    } finally {
      deleteMats(smallSrc, smallDst, temp);
    }
  }

  // boost saturation and value (brightness) to make colors pop
  // we can't use RGB here since simply multiplying the values can change the color
  // but we only want to change saturation
  // using HSV is better because it separates saturation and brightness from the Hue
  // now we can increase the Saturation easily and make color pop without messing original color
  function boostColor(cv, src, dst, saturationScale, valueScale, valueOffset) {
    const hsv = new cv.Mat(); // holds hue, saturation, value image
    try {
      cv.cvtColor(src, hsv, cv.COLOR_RGB2HSV); // convert to hsv since it separates color from brightness
      const data = hsv.data; // direct access to pixel array for speed

      // faster than built in function since we only directly change saturation and value(brightness)
      for (let i = 0; i < data.length; i += 3) { // skip by 3 since it's 3 channels
        data[i + 1] = clamp(data[i + 1] * saturationScale); // scale saturation up or down
        data[i + 2] = clamp(data[i + 2] * valueScale + valueOffset); // scale contrast and add offset(overall brightness)
      }
      cv.cvtColor(hsv, dst, cv.COLOR_HSV2RGB); // convert back to rgb for display
    } finally {
      deleteMats(hsv); // clean up our mats
    }
  }

  // reduce number of colors to create a blocky comic book effect
  function posterizeColors(cv, src, dst, levels) {
    const safeLevels = clamp(Math.round(levels), 2, 32); // keep levels reasonable to prevent crashes
    dst.create(src.rows, src.cols, cv.CV_8UC3); // allocate destination matrix
    const step = 255 / (safeLevels - 1); // calculate size of each color bucket
    const input = src.data;
    const output = dst.data;
    for (let i = 0; i < input.length; i += 3) {
      // round to nearest bucket and multiply by step to get new color value
      output[i] = clamp(Math.round(input[i] / step) * step); // r
      output[i + 1] = clamp(Math.round(input[i + 1] / step) * step); // g
      output[i + 2] = clamp(Math.round(input[i + 2] / step) * step); // b
    }
  }

  // blend black lines over the colored image
  function overlayInk(cv, color, whiteEdgeMask, dst, strength = 1) {
    dst.create(color.rows, color.cols, cv.CV_8UC3);
    const colorData = color.data;
    const edgeData = whiteEdgeMask.data; // edge mask where edges are dark
    const output = dst.data;
    for (let pixel = 0; pixel < edgeData.length; pixel += 1) {
      const colorIndex = pixel * 3; // 3 channels per pixel in color data
      // calculate how much ink to apply based on edge mask and strength
      const ink = clamp(((255 - edgeData[pixel]) / 255) * strength, 0, 1);
      const keep = 1 - ink; // how much original color to keep
      output[colorIndex] = colorData[colorIndex] * keep;
      output[colorIndex + 1] = colorData[colorIndex + 1] * keep;
      output[colorIndex + 2] = colorData[colorIndex + 2] * keep;
    }
  }

  // use k-means clustering to find dominant colors and group them
  // gives a painted or stylized look
  function applyKMeansQuantization(cv, src, dst, kLevels) {
    const safeK = clamp(Math.round(kLevels), 2, 32); // avoid infinite loops
    dst.create(src.rows, src.cols, cv.CV_8UC3);
    const sampleMat = new cv.Mat();
    try {
      // shrink image to 80x80 to make the math way faster
      cv.resize(src, sampleMat, new cv.Size(80, 80), 0, 0, cv.INTER_AREA); //moiré patterns prevention
      const sampleData = sampleMat.data;
      const numSamples = sampleData.length / 3; // total pixels
      const centroids = []; // holds our cluster center colors
      const step = Math.max(1, Math.floor(numSamples / safeK));
      // pick initial random-ish colors to start the clusters
      for (let i = 0; i < safeK; i += 1) {
        const idx = i * step * 3;
        centroids.push({ r: sampleData[idx], g: sampleData[idx + 1], b: sampleData[idx + 2] });
      }

      // run algorithm 5 times to let cluster centers settle
      for (let iter = 0; iter < 5; iter += 1) {
        // reset tracking arrays for this pass
        const sums = Array(safeK).fill(0).map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
        for (let i = 0; i < sampleData.length; i += 3) {
          const r = sampleData[i], g = sampleData[i + 1], b = sampleData[i + 2];
          let minDist = Infinity, bestCluster = 0;
          // find which cluster center this pixel is closest to
          for (let c = 0; c < safeK; c += 1) {
            const cent = centroids[c];
            // standard distance formula but without square root for speed
            const dist = (r - cent.r) * (r - cent.r) + (g - cent.g) * (g - cent.g) + (b - cent.b) * (b - cent.b);
            if (dist < minDist) { minDist = dist; bestCluster = c; }
          }
          // add pixel color to that cluster's sum
          sums[bestCluster].r += r; sums[bestCluster].g += g; sums[bestCluster].b += b;
          sums[bestCluster].count += 1;
        }
        // calculate new average color for each cluster center
        for (let c = 0; c < safeK; c += 1) {
          if (sums[c].count > 0) { // avoid division by zero
            centroids[c].r = sums[c].r / sums[c].count;
            centroids[c].g = sums[c].g / sums[c].count;
            centroids[c].b = sums[c].b / sums[c].count;
          }
        }
      }

      const inputData = src.data, outputData = dst.data;
      // now apply the found colors back to the full resolution image
      for (let i = 0; i < inputData.length; i += 3) {
        const r = inputData[i], g = inputData[i + 1], b = inputData[i + 2];
        let minDist = Infinity, bestCentroid = centroids[0];
        for (let c = 0; c < safeK; c += 1) {
          const cent = centroids[c];
          const dist = (r - cent.r) * (r - cent.r) + (g - cent.g) * (g - cent.g) + (b - cent.b) * (b - cent.b);
          if (dist < minDist) { minDist = dist; bestCentroid = cent; }
        }
        // assign the closest centroid color
        outputData[i] = clamp(Math.round(bestCentroid.r));
        outputData[i + 1] = clamp(Math.round(bestCentroid.g));
        outputData[i + 2] = clamp(Math.round(bestCentroid.b));
      }
    } finally {
      deleteMats(sampleMat);
    }
  }

  // apply global hatching to add diagonal shading lines in dark areas
  function applyGlobalHatching(cv, srcRgba, targetRgba) {
    const grayMat = new cv.Mat();
    try {
      cv.cvtColor(srcRgba, grayMat, cv.COLOR_RGBA2GRAY); // convert to grayscale to measure brightness
      const rows = targetRgba.rows, cols = targetRgba.cols;
      const lumData = grayMat.data, targetData = targetRgba.data;
      const hatchSpacing = 5, hatchThickness = 1; // configuration for line drawing

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const idx = r * cols + c;
          const luminance = lumData[idx]; // how bright the pixel is
          // use modulo math to draw diagonal lines
          const isPrimaryStroke = (r + c) % hatchSpacing < hatchThickness; // bottom-left to top-right
          const isSecondaryStroke = (r - c + cols) % hatchSpacing < hatchThickness; // top-left to bottom-right
          let shadeFactor = 1.0;

          if (luminance < 95) { // very dark areas get cross hatching
            if (isPrimaryStroke || isSecondaryStroke) shadeFactor = 0.65;
          } else if (luminance < 165) { // midtones just get single lines
            if (isPrimaryStroke) shadeFactor = 0.82;
          }

          if (shadeFactor < 1.0) { // apply shading if it hits the criteria
            const pIdx = idx * 4; // multiply by 4 for rgba indices
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

  // main cartoonification pipeline tying it all together
  function applyProCartoon(cv, src, settings) {
    const rgbMat = new cv.Mat(), smoothMat = new cv.Mat(), quantizedMat = new cv.Mat();
    const grayMat = new cv.Mat(), edgesMat = new cv.Mat(), edgesRgb = new cv.Mat();
    const finalDst = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U); // used for thickening lines
    // get border value from morphology if exists, otherwise use empty scalar, dummy fake value
    const borderValue = typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();

    try {
      cv.cvtColor(src, rgbMat, cv.COLOR_RGBA2RGB); // drop alpha channel
      // figure out how many passes to run based on settings
      const smoothingPasses = settings.cartoonSmoothingMode === 'lut-only' ? 0 : settings.cartoonSmoothingMode === 'single-bilateral' ? 1 : 2;
      edgePreservingSmooth(cv, rgbMat, smoothMat, settings.bilateralDiameter, 30, smoothingPasses); // smooth it out
      boostColor(cv, smoothMat, smoothMat, 1.4, 1.05, 0); // make colors pop
      applyKMeansQuantization(cv, smoothMat, quantizedMat, settings.colorQuantization); // group similar colors

      cv.cvtColor(rgbMat, grayMat, cv.COLOR_RGB2GRAY);
      cv.medianBlur(grayMat, grayMat, 5); // remove salt and pepper noise before edge detection

      const edgeIntensity = clamp(Math.round(settings.edgeIntensity), 1, 12);
      // calculate dynamic block size for edge detection
      const adaptiveBlockSize = oddKernel(settings.bilateralDiameter + settings.edgeBlockSize * 2 + 5, 9);
      const adaptiveC = clamp(11 - edgeIntensity, 2, 10); // constant subtracted from mean

      // find edges by comparing pixels to local neighborhoods
      cv.adaptiveThreshold(grayMat, edgesMat, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, adaptiveBlockSize, adaptiveC);
      if (edgeThickness > 1) { // thicken lines if needed
        cv.dilate(edgesMat, edgesMat, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, borderValue);
      }

      cv.bitwise_not(edgesMat, edgesMat); // invert lines to black on white
      cv.cvtColor(edgesMat, edgesRgb, cv.COLOR_GRAY2RGB); // back to rgb to combine
      cv.bitwise_and(quantizedMat, edgesRgb, finalDst); // merge colors and lines
      return matToRgba(cv, finalDst); // ready for canvas
    } finally {
      // sweep up all those mats
      deleteMats(rgbMat, smoothMat, quantizedMat, grayMat, edgesMat, edgesRgb, finalDst, kernel);
    }
  }

  // creates a realistic pencil sketch effect using color dodge trick
  function applyAdvancedPencil(cv, src, settings) {
    const grayMat = new cv.Mat(), invertedMat = new cv.Mat(), blurredMat = new cv.Mat();
    const invertedBlurredMat = new cv.Mat(), baseSketch = new cv.Mat(), edgesMat = new cv.Mat();
    const finalDst = new cv.Mat();

    try {
      const blurStrength = Math.max(1, Math.round(settings.bilateralDiameter || 9));
      const ksize = oddKernel(blurStrength * 4 + 1, 5); // scale kernel size based on strength
      cv.cvtColor(src, grayMat, cv.COLOR_RGBA2GRAY); // everything in grayscale for sketch
      cv.bitwise_not(grayMat, invertedMat); // invert grayscale
      // blur the inverted image to lose high frequency details
      cv.GaussianBlur(invertedMat, blurredMat, new cv.Size(ksize, ksize), 0, 0, cv.BORDER_DEFAULT);
      cv.bitwise_not(blurredMat, invertedBlurredMat); // invert blur back
      cv.divide(grayMat, invertedBlurredMat, baseSketch, 256.0); // color dodge blend mode equation

      const edgeBlockSize = oddKernel(blurStrength * 2 + 3, 9);
      // get clean outlines using adaptive threshold
      cv.adaptiveThreshold(grayMat, edgesMat, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, edgeBlockSize, 5);

      finalDst.create(src.rows, src.cols, cv.CV_8UC1);
      const sketchData = baseSketch.data, edgeData = edgesMat.data, outData = finalDst.data;
      for (let i = 0; i < outData.length; i += 1) {
        // if it's an edge, darken the sketch pixel, otherwise keep sketch
        outData[i] = edgeData[i] > 0 ? clamp(sketchData[i] * 0.25) : sketchData[i];
      }
      return matToRgba(cv, finalDst);
    } finally {
      deleteMats(grayMat, invertedMat, blurredMat, invertedBlurredMat, baseSketch, edgesMat, finalDst);
    }
  }

  // andy warhol / roy lichtenstein style comic effect with halftone dots
  function applyPopArt(cv, src, settings) {
    const rgb = new cv.Mat(), smooth = new cv.Mat(), gray = new cv.Mat();
    const edges = new cv.Mat(), whiteLineMask = new cv.Mat(), boosted = new cv.Mat();
    const colorBase = new cv.Mat(), halftone = new cv.Mat(), pop = new cv.Mat();
    const edgeThickness = Math.max(1, Math.round(settings.edgeBlockSize));
    const kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U); // used for dilating edges later

    try {
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      edgePreservingSmooth(cv, rgb, smooth, 8, 24); // flatten colors out
      boostColor(cv, smooth, boosted, 1.35, 0.9, -10); // crank saturation, lower brightness a tiny bit
      posterizeColors(cv, boosted, colorBase, clamp(Math.round(settings.colorQuantization / 3), 3, 10)); // blocky retro colors
      colorBase.copyTo(halftone); // clone color base to draw dots onto
      cv.cvtColor(colorBase, gray, cv.COLOR_RGB2GRAY); // convert to gray for brightness check

      const dotSize = Math.max(4, Math.round(settings.dotSize));
      const base = colorBase.data, grayData = gray.data;

      // loop in grid chunks to draw halftone dots
      for (let y = 0; y < gray.rows; y += dotSize) {
        for (let x = 0; x < gray.cols; x += dotSize) {
          // handle edges of image properly so we don't go out of bounds
          const cellWidth = Math.min(dotSize, gray.cols - x);
          const cellHeight = Math.min(dotSize, gray.rows - y);
          let brightness = 0, red = 0, green = 0, blue = 0, count = 0;

          // average out colors and brightness within this grid cell
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
          const darkness = 1 - brightness / 255; // darker areas get bigger dots
          const radius = Math.round(Math.pow(darkness, 0.7) * dotSize * 0.62); // calculate dot size
          if (radius < 1) continue; // skip if dot is too small

          // find middle of the cell
          const center = new cv.Point(Math.round(x + cellWidth / 2), Math.round(y + cellHeight / 2));
          // draw the dot using darkened version of the cell's average color
          cv.circle(halftone, center, radius, new cv.Scalar(red * 0.28, green * 0.24, blue * 0.22), -1, cv.LINE_AA);
        }
      }

      // detect hard lines for comic book ink look
      const lowThreshold = clamp(92 - settings.edgeIntensity * 6, 26, 78);
      cv.Canny(gray, edges, lowThreshold, lowThreshold * 2.2, 3, false); // canny edge detection
      cv.dilate(edges, edges, kernel); // thicken lines
      cv.bitwise_not(edges, whiteLineMask); // invert mask
      overlayInk(cv, halftone, whiteLineMask, pop, 1.0); // composite it all together
      return matToRgba(cv, pop);
    } finally {
      deleteMats(rgb, smooth, gray, edges, whiteLineMask, kernel, boosted, colorBase, halftone, pop);
    }
  }

  // --- Optimized CPU-based Anisotropic Kuwahara Filter ---
  // --- Optimized CPU-based Anisotropic Kuwahara Filter with Optional Edge Overlay ---
  // simulates brush strokes that follow the contours of the image
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
      // math here is mathematically expensive so we downscale if image is too large
      const targetWidth = Math.min(src.cols, 400);
      const scale = targetWidth / src.cols;
      const targetHeight = Math.max(1, Math.round(src.rows * scale));

      cv.resize(src, workSrc, new cv.Size(targetWidth, targetHeight), 0, 0, cv.INTER_AREA);
      cv.cvtColor(workSrc, rgb, cv.COLOR_RGBA2RGB); // drop alpha

      // Saturate paint colors slightly to enrich pigments
      boostColor(cv, rgb, rgb, 1.35, 1.05, 0); // make colors pop
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

      // 2. Compute Structure Tensor Gradients natively
      // finds edges in x and y directions
      cv.Sobel(gray, sobelX, cv.CV_32F, 1, 0, 3);
      cv.Sobel(gray, sobelY, cv.CV_32F, 0, 1, 3);

      // multiply gradients to get structure tensor elements
      cv.multiply(sobelX, sobelX, jxx);
      cv.multiply(sobelY, sobelY, jyy);
      cv.multiply(sobelX, sobelY, jxy);

      // Gaussian integration smoothes the local orientation flow map
      const radius = clamp(Math.round(settings.bilateralDiameter || 5), 2, 8);
      const blurSize = oddKernel(radius + 2, 5); // calculate odd window size
      // blur the tensors to get broader structure awareness
      cv.GaussianBlur(jxx, jxx, new cv.Size(blurSize, blurSize), 0, 0);
      cv.GaussianBlur(jyy, jyy, new cv.Size(blurSize, blurSize), 0, 0);
      cv.GaussianBlur(jxy, jxy, new cv.Size(blurSize, blurSize), 0, 0);

      // 3. Precompute rotated directional sector offsets caching
      // stores pixel coordinates for 4 quadrants rotated to 16 different angles
      if (!self.__kuwaharaSectorsCache) {
        self.__kuwaharaSectorsCache = {}; // attach to global self to persist between frames
      }
      const cacheKey = radius; // radius determines the size of the quadrants
      if (!self.__kuwaharaSectorsCache[cacheKey]) {
        const numAngles = 16;
        const cachedAngles = [];
        for (let a = 0; a < numAngles; a += 1) {
          const phi = (a / numAngles) * Math.PI; // angle in radians
          const cosP = Math.cos(phi);
          const sinP = Math.sin(phi);
          const sectors = [];

          // define the 4 quadrants based on radius
          const quadrants = [
            { uMin: 0, uMax: radius, vMin: 0, vMax: radius }, // bottom right
            { uMin: -radius, uMax: 0, vMin: 0, vMax: radius }, // bottom left
            { uMin: -radius, uMax: 0, vMin: -radius, vMax: 0 }, // top left
            { uMin: 0, uMax: radius, vMin: -radius, vMax: 0 }, // top right
          ];

          for (let q = 0; q < 4; q += 1) {
            const offsets = [];
            const seen = new Set(); // prevent duplicate pixels due to rounding
            const quad = quadrants[q];
            for (let v = quad.vMin; v <= quad.vMax; v += 1) {
              for (let u = quad.uMin; u <= quad.uMax; u += 1) {
                // rotate coordinates by angle phi
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
        self.__kuwaharaSectorsCache[cacheKey] = cachedAngles; // save to cache
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
          // finds main direction of edges at this pixel
          const twoTheta = Math.atan2(2 * F, E - G);
          let phi = twoTheta / 2 + Math.PI / 2; // rotate 90 degrees to get brush direction
          // keep angle within bounds
          if (phi < 0) phi += Math.PI;
          if (phi >= Math.PI) phi -= Math.PI;

          // map angle to one of our 16 precomputed bins
          const angleBin = Math.floor((phi / Math.PI) * numAngles) % numAngles;
          const sectors = cachedSectors[angleBin];

          let minVariance = Infinity;
          let bestR = 0, bestG = 0, bestB = 0;

          // Process the 4 directional sub-regions using single-pass variance math
          // find which of the 4 quadrants is the flattest (least variance in color)
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
              // bounds checking so we don't read out of array
              if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                const idx = (sy * width + sx) * 3;
                const r = srcData[idx], g = srcData[idx + 1], b = srcData[idx + 2];
                sumR += r; sumG += g; sumB += b;
                sumSqR += r * r; sumSqG += g * g; sumSqB += b * b; // square values for variance
                count += 1;
              }
            }

            if (count > 0) {
              const meanR = sumR / count;
              const meanG = sumG / count;
              const meanB = sumB / count;

              // Var = E[X^2] - (E[X])^2
              // standard fast variance formula
              const varR = sumSqR / count - meanR * meanR;
              const varG = sumSqG / count - meanG * meanG;
              const varB = sumSqB / count - meanB * meanB;
              const totalVar = varR + varG + varB;

              // save color of quadrant with lowest variance
              if (totalVar < minVariance) {
                minVariance = totalVar;
                bestR = meanR; bestG = meanG; bestB = meanB;
              }
            }
          }

          const outIdx = pIdx * 3;
          // write the smoothed color out
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
        if (edgeThickness > 1) { // thicken borders
          kernel = cv.Mat.ones(edgeThickness, edgeThickness, cv.CV_8U);
          const borderValue = typeof cv.morphologyDefaultBorderValue === 'function' ? cv.morphologyDefaultBorderValue() : new cv.Scalar();
          cv.dilate(edgesMat, edgesMat, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, borderValue);
        }

        // Invert back to black lines on white mask, convert to RGB, and combine
        cv.bitwise_not(edgesMat, edgesMat);
        cv.cvtColor(edgesMat, edgesRgb, cv.COLOR_GRAY2RGB);
        cv.bitwise_and(dst, edgesRgb, dst); // paste lines onto paint
      }

      // Smoothly upscale back to standard rendering dimensions
      // bilinearly interpolate to avoid blockiness after doing low-res kuwahara
      cv.resize(dst, dst, new cv.Size(src.cols, src.rows), 0, 0, cv.INTER_LINEAR);
      return matToRgba(cv, dst); // convert and return
    } finally {
      deleteMats(workSrc, rgb, gray, sobelX, sobelY, jxx, jyy, jxy, dst, edgesMat, edgesRgb);
      if (kernel) deleteMats(kernel); // cleanup optional kernel too
    }
  } 

  // router function that decides which algorithm to run based on settings
  function applyFilter(cv, src, settings) {
    let result;
    if (settings.mode === 'pencil') {
      result = applyAdvancedPencil(cv, src, settings);
    } else if (settings.mode === 'popart') {
      result = applyPopArt(cv, src, settings);
    } else if (settings.mode === 'oilpainting') {
      result = applyOilPainting(cv, src, settings);
    } else {
      result = applyProCartoon(cv, src, settings); // default to cartoon
    }

    // Explicitly restrict cross-hatching to cartoon/pencil lines to avoid muddying smooth oil textures
    // only apply shading where it makes sense stylistically
    if (settings.mode === 'cartoon' || settings.mode === 'pencil') {
      applyGlobalHatching(cv, src, result);
    }
    return result;
  }

  // expose to global object (window or worker context)
  globalScope.CartoonifierFilters = {
    applyFilter,
    deleteMats,
  };
})(self); // iife passes self as globalScope