# **Project Blueprint: Web-Based Real-Time Cartoonifier**

## **1\. Project Overview**

Build a client-side Single Page Application (SPA) that applies Digital Image Processing (DIP) filters to real-time webcam feeds, uploaded images, and uploaded videos. The application must run entirely in the browser without any backend processing.

## **2\. Technology Stack**

* **Frontend Framework:** React (using Vite) or Vanilla JS \+ ES6 Modules.  
* **Styling:** Tailwind CSS (Dark/Modern theme).  
* **DIP Engine:** OpenCV.js (WebAssembly version loaded via CDN: https://docs.opencv.org/4.x/opencv.js).  
* **Performance:** Web Workers **must** be used to handle OpenCV matrix operations to prevent blocking the main UI thread.

## **3\. System Architecture (Producer-Consumer Model)**

* **Main Thread (UI):** \* Handles DOM, webcam capture (getUserMedia), file uploads, and UI state (sliders/buttons).  
  * Extracts frames from the \<video\> element to an off-screen \<canvas\>.  
  * Sends ImageData to the Web Worker via postMessage.  
  * Receives processed ImageData and draws it to the visible \<canvas\>.  
* **Web Worker (Engine):**  
  * Initializes OpenCV.js (cv.onRuntimeInitialized).  
  * Receives ImageData, converts it to cv.Mat.  
  * Applies the selected DIP filter pipeline.  
  * Converts back to ImageData and sends it back to the Main Thread.  
  * *Crucial:* Downsample video frames before processing (e.g., max-width 640px) to maintain high FPS, then scale up on the display canvas.

## **4\. Input & Output Requirements**

* **Webcam Mode:** Real-time processing loop using requestAnimationFrame.  
* **Media Upload Mode:** Support for \<input type="file"\> for both image/\* and video/\*. Process video uploads frame-by-frame during playback.  
* **Snapshot:** A button to download the current frame on the output canvas as a .png.

## **5\. Adjustable Parameters (UI Sliders)**

The UI must include live-updating sliders that pass their values to the Web Worker state:

1. Filter Mode: Dropdown (Cartoon, Pencil Sketch, Pop-Art).  
2. Bilateral Diameter / Smoothing: (Range: 5 \- 15\)  
3. Edge Thickness (Block Size): (Range: 3 \- 21, must be odd numbers)  
4. Edge Intensity (C value): (Range: 2 \- 10\)  
5. Color Quantization (K): (Range: 4 \- 16\) \- *For Cartoon Mode*  
6. Dot Size / Grid Size: (Range: 4 \- 20\) \- *For Pop-Art Mode*

## **6\. DIP Filter Pipelines (OpenCV.js Logic)**

### **Mode 1: Classic Cartoon (Filter Approach)**

1. **Downsample:** Resize to improve speed.  
2. **Color Smoothing:** Apply cv.bilateralFilter iteratively (2-3 times) to flatten textures.  
3. **Color Quantization (Optional but preferred):** Use K-Means clustering to reduce the image to a distinct color palette (e.g., 8 colors).  
4. **Edge Detection:** \* Convert original to grayscale (cv.cvtColor).  
   * Apply median blur (cv.medianBlur) to remove noise.  
   * Apply cv.adaptiveThreshold to extract clean, bold black lines.  
5. **Merge:** Use cv.bitwise\_and to combine the smoothed color image and the thresholded edge mask.

### **Mode 2: Pencil Sketch**

1. **Grayscale:** Convert image to grayscale.  
2. **Invert:** Invert the grayscale image (cv.bitwise\_not).  
3. **Blur:** Apply a heavy Gaussian Blur (cv.GaussianBlur) to the inverted image.  
4. **Color Dodge Blend:** Blend the original grayscale with the blurred inverted image.  
   * *Math:* Result \= (Grayscale \* 255\) / (255 \- Blurred).  
   * *Implementation Note:* In OpenCV.js, this is often achieved using cv.divide with a scale factor of 256\.

### **Mode 3: Pop-Art (Roy Lichtenstein Halftone Style)**

1. **Color Separation / Setup:** Create a vivid, high-saturation version of the base image.  
2. **Halftone Grid (The Dots):**  
   * Divide the image into a grid of cells (size controlled by Dot Size slider).  
   * For each cell, calculate the average brightness (luminance).  
   * Draw a filled circle (cv.circle) in the center of the cell on a blank canvas. The radius of the circle should be inversely proportional to the brightness (darker areas \= larger dots).  
3. **Comic Outlines:** Apply a heavy global threshold or Canny edge detection and overlay it in thick black on top of the halftone dots to give it that comic book print feel.

## **7\. Strict Constraints for the AI Agent**

* **DO NOT** generate a backend server (no Express, no Flask, no Python).  
* **DO NOT** use external APIs or Machine Learning GANs for the cartoon effect. You must use mathematical OpenCV filters.  
* **DO** handle the asynchronous loading of OpenCV.js properly. Show a loading spinner until cv is fully initialized in the worker.  
* **DO** ensure all cv.Mat objects are properly deleted (mat.delete()) inside the Web Worker to prevent memory leaks, which will crash the browser during real-time video processing.