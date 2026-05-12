const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
const workerParams = new URL(self.location.href).searchParams;
const FILTERS_URL = new URL(workerParams.get('filtersUrl') || '../cartoonifier-filters.js', self.location.href).href;

const defaultSettings = {
  mode: 'cartoon',
  cartoonSmoothingMode: 'double-bilateral',
  bilateralDiameter: 9,
  edgeBlockSize: 2,
  edgeIntensity: 5,
  colorQuantization: 24,
  dotSize: 10,
};

let cvReady = false;
let filtersReady = false;
let settings = { ...defaultSettings };

function postError(error) {
  self.postMessage({
    type: 'error',
    message: error?.message || String(error),
  });
}

function loadEngine() {
  return new Promise((resolve, reject) => {
    let engineFinished = false;
    const timeout = setTimeout(() => {
      reject(new Error('OpenCV.js took too long to initialize'));
    }, 45000);

    const finish = () => {
      if (engineFinished) return;
      engineFinished = true;

      try {
        importScripts(FILTERS_URL);
        filtersReady = Boolean(self.CartoonifierFilters?.applyFilter);
        if (!filtersReady) {
          throw new Error('Filter engine failed to initialize');
        }
        clearTimeout(timeout);
        cvReady = true;
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    };

    self.Module = {
      onRuntimeInitialized: finish,
    };

    try {
      importScripts(OPENCV_URL);

      if (self.cv?.ready instanceof Promise) {
        self.cv.ready.then(finish, reject);
      } else if (self.cv && !self.cv.Mat) {
        self.cv.onRuntimeInitialized = finish;
      } else if (self.cv?.Mat) {
        finish();
      }
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function normalizeSettings(nextSettings) {
  return {
    ...settings,
    ...nextSettings,
    edgeBlockSize: Math.max(1, Math.round(nextSettings.edgeBlockSize ?? settings.edgeBlockSize)),
    bilateralDiameter: Math.max(1, Math.round(nextSettings.bilateralDiameter ?? settings.bilateralDiameter)),
    colorQuantization: Math.max(2, Math.round(nextSettings.colorQuantization ?? settings.colorQuantization)),
    dotSize: Math.max(2, Math.round(nextSettings.dotSize ?? settings.dotSize)),
    cartoonSmoothingMode: nextSettings.cartoonSmoothingMode ?? settings.cartoonSmoothingMode,
  };
}

function processFrame({ imageData, frameId }) {
  if (!cvReady || !filtersReady) {
    throw new Error('OpenCV filter engine is still loading');
  }

  const startedAt = performance.now();
  const src = cv.matFromImageData(imageData);
  let result = null;

  try {
    result = self.CartoonifierFilters.applyFilter(cv, src, settings);
    const output = new ImageData(new Uint8ClampedArray(result.data), result.cols, result.rows);

    self.postMessage(
      {
        type: 'processedFrame',
        frameId,
        processingMs: performance.now() - startedAt,
        imageData: output,
      },
      [output.data.buffer],
    );
  } finally {
    self.CartoonifierFilters.deleteMats(src, result);
  }
}

self.onmessage = (event) => {
  const message = event.data;

  try {
    if (message.type === 'settings') {
      settings = normalizeSettings(message.settings || {});
      return;
    }

    if (message.type === 'processFrame') {
      processFrame(message);
    }
  } catch (error) {
    postError(error);
  }
};

loadEngine()
  .then(() => {
    self.postMessage({ type: 'ready' });
  })
  .catch(postError);
