# Real-Time Cartoonizer

A high-performance, browser-based web application that applies real-time digital image processing filters to your media. Built with React, Vite, Tailwind CSS, and OpenCV, this tool allows you to transform images, videos, and live webcam feeds into stylized art directly in your browser.

This project was created for the Digital Image Processing (DIP) final lab by:
- **Muhammad Haris** (FA23-BCS-010)
- **Yaman Tariq** (FA23-BCS-168)

## Features

- **Real-Time Processing**: Process live webcam feeds and video files with a client-side OpenCV web worker.
- **Multiple Sources**: Upload static images, play local video files, or use your device's webcam.
- **Stylization Modes**:
  - **Cartoon**: Classic cel-shaded look with adjustable edge intensity, color quantization, and bilateral smoothing.
  - **Pencil Sketch**: Grayscale sketched appearance with adjustable blur strength.
  - **Pop-Art**: Halftone comic book style with customizable grid/dot sizes.
  - **Oil Painting**: Smooth, painted effect using advanced Kuwahara filtering.
- **Granular Controls**: Fine-tune the effects with intuitive UI sliders for edge thickness, blur radii, and more.
- **Exporting**: Save snapshots of your processed media with a single click.

## Technology Stack

- **Frontend Framework**: [React 19](https://react.dev/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Icons**: [Lucide React](https://lucide.dev/)
- **Image Processing**: [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) via Web Workers

## Getting Started

### Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd Cartoonizer
   ```

2. Install the project dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to `http://localhost:5173` to see the application running.

## Building for Production

To create an optimized production build, run:
```bash
npm run build
```

This will generate a `dist` directory with the compiled assets. You can preview the production build locally using:
```bash
npm run preview
```

## How It Works

The application leverages **Web Workers** to keep the main UI thread responsive. Media frames (from webcam, video, or canvas) are captured, serialized as `ImageData`, and sent to the OpenCV worker. The worker applies the selected image processing algorithms (such as bilateral filtering, Canny edge detection, and color quantization) and returns the processed frame to be rendered on an HTML `<canvas>`. All processing happens entirely client-side, ensuring privacy and fast performance without backend dependencies.

## License

This project is intended for educational and personal use.
