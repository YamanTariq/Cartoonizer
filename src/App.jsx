import {
  Download,
  Image as ImageIcon,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Video,
  Webcam,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import opencvWorkerUrl from './workers/opencv.worker.js?worker&url';

const PROCESSING_WIDTH = 900;
const FRAME_INTERVAL_MS = 30;

const defaultSettings = {
  mode: 'cartoon',
  cartoonSmoothingMode: 'double-bilateral',
  bilateralDiameter: 9,
  edgeBlockSize: 2,
  edgeIntensity: 5,
  colorQuantization: 24,
  dotSize: 10,
};

const modeLabels = {
  cartoon: 'Cartoon',
  pencil: 'Pencil Sketch',
  popart: 'Pop-Art',
};

const sourceLabels = {
  webcam: 'Webcam',
  image: 'Image',
  video: 'Video',
};

function Slider({ label, value, min, max, step = 1, suffix = '', onChange }) {
  return (
    <label className="grid gap-2 rounded border border-white/10 bg-white/[0.04] p-3">
      <span className="flex items-center justify-between gap-4 text-sm text-slate-200">
        <span>{label}</span>
        <span className="rounded bg-slate-950/80 px-2 py-1 text-xs font-semibold text-cyan-200">
          {value}
          {suffix}
        </span>
      </span>
      <input
        className="h-2 w-full cursor-pointer"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SourceButton({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      className={`flex min-h-11 items-center justify-center gap-2 rounded border px-3 text-sm font-semibold transition ${
        active
          ? 'border-cyan-300 bg-cyan-300 text-slate-950'
          : 'border-white/10 bg-white/[0.04] text-slate-200 hover:border-white/25 hover:bg-white/[0.08]'
      }`}
      onClick={onClick}
    >
      <Icon size={17} />
      {label}
    </button>
  );
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export default function App() {
  const [source, setSource] = useState('webcam');
  const [settings, setSettings] = useState(defaultSettings);
  const [workerStatus, setWorkerStatus] = useState('loading');
  const [statusText, setStatusText] = useState('Loading OpenCV worker...');
  const [mediaLabel, setMediaLabel] = useState('No media selected');
  const [processingTime, setProcessingTime] = useState(null);
  const [fps, setFps] = useState(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1280, height: 720 });
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const workerRef = useRef(null);
  const videoRef = useRef(null);
  const imageRef = useRef(null);
  const sourceCanvasRef = useRef(null);
  const outputCanvasRef = useRef(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const streamRef = useRef(null);
  const animationRef = useRef(null);
  const workerBusyRef = useRef(false);
  const readyRef = useRef(false);
  const frameIdRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const stillImageDataRef = useRef(null);
  const pendingStillReprocessRef = useRef(false);
  const objectUrlRef = useRef(null);
  const sourceRef = useRef(source);

  const normalizedSettings = useMemo(
    () => ({
      ...settings,
      edgeBlockSize: Math.max(1, Math.round(settings.edgeBlockSize)),
    }),
    [settings],
  );

  const stopLoop = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const stopWebcam = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const clearObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const drawPlaceholder = useCallback((message = 'Choose a source to begin') => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;

    const width = 1280;
    const height = 720;
    canvas.width = width;
    canvas.height = height;
    setCanvasSize({ width, height });

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#0f172a');
    gradient.addColorStop(0.52, '#111827');
    gradient.addColorStop(1, '#164e63');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.font = '600 42px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height / 2);
  }, []);

  const postSettings = useCallback((nextSettings) => {
    workerRef.current?.postMessage({
      type: 'settings',
      settings: nextSettings,
    });
  }, []);

  const renderProcessedFrame = useCallback((imageData) => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      setCanvasSize({ width: imageData.width, height: imageData.height });
    }

    ctx.putImageData(imageData, 0, 0);
  }, []);

  const sendFrame = useCallback((imageData) => {
    if (!readyRef.current || workerBusyRef.current || !workerRef.current) return false;

    workerBusyRef.current = true;
    frameIdRef.current += 1;
    workerRef.current.postMessage(
      {
        type: 'processFrame',
        frameId: frameIdRef.current,
        width: imageData.width,
        height: imageData.height,
        imageData,
      },
      [imageData.data.buffer],
    );

    return true;
  }, []);

  const captureVideoFrame = useCallback(() => {
    const video = videoRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    if (!video || !sourceCanvas || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    const scale = Math.min(1, PROCESSING_WIDTH / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    sourceCanvas.width = width;
    sourceCanvas.height = height;

    const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }, []);

  const processStillImage = useCallback(() => {
    const sourceCanvas = sourceCanvasRef.current;
    const image = imageRef.current;
    if (!sourceCanvas || !image || !image.complete || image.naturalWidth === 0) return;

    const scale = Math.min(1, PROCESSING_WIDTH / image.naturalWidth);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    sourceCanvas.width = width;
    sourceCanvas.height = height;

    const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    stillImageDataRef.current = imageData;
    sendFrame(new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height));
  }, [sendFrame]);

  const processPausedVideoFrame = useCallback(() => {
    const video = videoRef.current;
    if (sourceRef.current !== 'video' || !video || !video.paused || !readyRef.current || workerBusyRef.current) return;

    const imageData = captureVideoFrame();
    if (imageData) {
      sendFrame(imageData);
    }
  }, [captureVideoFrame, sendFrame]);

  const startLoop = useCallback(() => {
    stopLoop();

    const tick = (timestamp) => {
      const video = videoRef.current;
      const elapsedSinceLastFrame = timestamp - lastFrameTimeRef.current;
      const shouldProcess =
        readyRef.current &&
        !workerBusyRef.current &&
        video &&
        video.readyState >= 2 &&
        !video.paused &&
        !video.ended &&
        (!lastFrameTimeRef.current || elapsedSinceLastFrame >= FRAME_INTERVAL_MS);

      if (shouldProcess) {
        const imageData = captureVideoFrame();
        if (imageData) {
          sendFrame(imageData);
          if (elapsedSinceLastFrame > 0) {
            setFps(Math.round(1000 / elapsedSinceLastFrame));
          }
          lastFrameTimeRef.current = timestamp;
        }
      }

      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
  }, [captureVideoFrame, sendFrame, stopLoop]);

  const startWebcam = useCallback(async () => {
    stopLoop();
    clearObjectUrl();
    stillImageDataRef.current = null;
    lastFrameTimeRef.current = 0;
    setSource('webcam');
    setMediaLabel('Webcam feed');
    setStatusText(readyRef.current ? 'Requesting camera access...' : 'Waiting for OpenCV...');

    try {
      stopWebcam();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: false,
      });

      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      setIsPlaying(true);
      setStatusText('Webcam processing');
      startLoop();
    } catch (error) {
      setIsPlaying(false);
      setStatusText(error?.name === 'NotAllowedError' ? 'Camera permission denied' : 'Unable to start webcam');
      drawPlaceholder('Camera unavailable');
    }
  }, [clearObjectUrl, drawPlaceholder, startLoop, stopLoop, stopWebcam]);

  const handleImageUpload = useCallback(
    (file) => {
      if (!file) return;

      stopLoop();
      stopWebcam();
      clearObjectUrl();
      lastFrameTimeRef.current = 0;
      setSource('image');
      setMediaLabel(file.name);
      setIsPlaying(false);
      setFps(null);
      setVideoCurrentTime(0);
      setVideoDuration(0);
      setStatusText(readyRef.current ? 'Processing image' : 'Waiting for OpenCV...');

      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      const image = imageRef.current;
      image.onload = () => processStillImage();
      image.onerror = () => {
        setStatusText('Unable to load image');
        drawPlaceholder('Image load failed');
      };
      image.src = url;
    },
    [clearObjectUrl, drawPlaceholder, processStillImage, stopLoop, stopWebcam],
  );

  const handleVideoUpload = useCallback(
    async (file) => {
      if (!file) return;

      stopLoop();
      stopWebcam();
      clearObjectUrl();
      stillImageDataRef.current = null;
      lastFrameTimeRef.current = 0;
      setSource('video');
      setMediaLabel(file.name);
      setVideoCurrentTime(0);
      setVideoDuration(0);
      setStatusText(readyRef.current ? 'Loading video' : 'Waiting for OpenCV...');

      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      const video = videoRef.current;
      video.srcObject = null;
      video.src = url;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;

      try {
        await video.play();
        setIsPlaying(true);
        setStatusText('Video processing');
        startLoop();
      } catch {
        setIsPlaying(false);
        setStatusText('Press play to process uploaded video');
      }
    },
    [clearObjectUrl, startLoop, stopLoop, stopWebcam],
  );

  const toggleVideoPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video || source === 'image') return;

    if (video.paused) {
      try {
        await video.play();
        setIsPlaying(true);
        setStatusText(source === 'webcam' ? 'Webcam processing' : 'Video processing');
        startLoop();
      } catch {
        setStatusText('Playback could not start');
      }
    } else {
      video.pause();
      setIsPlaying(false);
      setStatusText(source === 'webcam' ? 'Webcam paused' : 'Video paused');
    }
  }, [source, startLoop]);

  const seekVideoBy = useCallback(
    (seconds) => {
      const video = videoRef.current;
      if (!video || source !== 'video' || !Number.isFinite(video.duration)) return;

      video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + seconds));
      setVideoCurrentTime(video.currentTime);
      lastFrameTimeRef.current = 0;
      processPausedVideoFrame();
    },
    [processPausedVideoFrame, source],
  );

  const scrubVideoTo = useCallback(
    (seconds) => {
      const video = videoRef.current;
      if (!video || source !== 'video') return;

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = duration > 0 ? Math.min(duration, Math.max(0, seconds)) : 0;
      setVideoCurrentTime(video.currentTime);
      lastFrameTimeRef.current = 0;
      processPausedVideoFrame();
    },
    [processPausedVideoFrame, source],
  );

  const downloadSnapshot = useCallback(() => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;

    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `cartoonifier-${timestamp}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(defaultSettings);
  }, []);

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    drawPlaceholder('Loading OpenCV...');

    const workerUrl = new URL(opencvWorkerUrl, window.location.href);
    workerUrl.searchParams.set('filtersUrl', `${import.meta.env.BASE_URL}cartoonifier-filters.js`);
    const worker = new Worker(workerUrl);
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const { type } = event.data;

      if (type === 'ready') {
        readyRef.current = true;
        setWorkerStatus('ready');
        setStatusText('OpenCV ready');
        postSettings(normalizedSettings);
        if (sourceRef.current === 'image' && stillImageDataRef.current) {
          const data = stillImageDataRef.current;
          sendFrame(new ImageData(new Uint8ClampedArray(data.data), data.width, data.height));
        }
      }

      if (type === 'processedFrame') {
        const { imageData, processingMs } = event.data;
        workerBusyRef.current = false;
        setProcessingTime(Math.round(processingMs));
        renderProcessedFrame(imageData);

        if (sourceRef.current === 'image') {
          if (pendingStillReprocessRef.current && stillImageDataRef.current) {
            pendingStillReprocessRef.current = false;
            const data = stillImageDataRef.current;
            sendFrame(new ImageData(new Uint8ClampedArray(data.data), data.width, data.height));
          } else {
            setStatusText('Image processed');
          }
        }
      }

      if (type === 'error') {
        workerBusyRef.current = false;
        setWorkerStatus('error');
        setStatusText(event.data.message || 'OpenCV worker error');
      }
    };

    worker.onerror = (error) => {
      workerBusyRef.current = false;
      readyRef.current = false;
      setWorkerStatus('error');
      setStatusText(error.message || 'OpenCV worker crashed');
    };

    return () => {
      stopLoop();
      stopWebcam();
      clearObjectUrl();
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    postSettings(normalizedSettings);

    if (source === 'image' && stillImageDataRef.current && readyRef.current) {
      const data = stillImageDataRef.current;
      if (workerBusyRef.current) {
        pendingStillReprocessRef.current = true;
      } else {
        sendFrame(new ImageData(new Uint8ClampedArray(data.data), data.width, data.height));
      }
    }
  }, [normalizedSettings, postSettings, sendFrame, source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const handleEnded = () => setIsPlaying(false);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleLoadedMetadata = () => {
      setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setVideoCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    };
    const handleTimeUpdate = () => {
      setVideoCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    };
    const handleSeeked = () => {
      setVideoCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
      processPausedVideoFrame();
    };

    video.addEventListener('ended', handleEnded);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('durationchange', handleLoadedMetadata);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('seeked', handleSeeked);

    return () => {
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('durationchange', handleLoadedMetadata);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [processPausedVideoFrame]);

  const readiness = workerStatus === 'ready' ? 'Ready' : workerStatus === 'error' ? 'Error' : 'Loading';

  return (
    <main className="min-h-screen px-4 py-5 text-slate-50 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">Digital Image Processing</p>
              <h1 className="mt-2 text-3xl font-black tracking-normal text-white sm:text-4xl">Real-Time Cartoonifier</h1>
            </div>
            <div className="grid grid-cols-3 gap-2 md:w-[390px]">
              <SourceButton active={source === 'webcam'} icon={Webcam} label="Webcam" onClick={startWebcam} />
              <SourceButton active={source === 'image'} icon={ImageIcon} label="Image" onClick={() => imageInputRef.current?.click()} />
              <SourceButton active={source === 'video'} icon={Video} label="Video" onClick={() => videoInputRef.current?.click()} />
            </div>
          </div>

          <div className="overflow-hidden rounded border border-white/10 bg-slate-950/70 shadow-panel">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`h-2.5 w-2.5 rounded-full ${workerStatus === 'ready' ? 'bg-emerald-300' : workerStatus === 'error' ? 'bg-rose-400' : 'bg-amber-300'}`} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{statusText}</p>
                  <p className="truncate text-xs text-slate-400">
                    {sourceLabels[source]} · {mediaLabel}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <span className="rounded bg-white/[0.06] px-2.5 py-1.5">{readiness}</span>
                <span className="rounded bg-white/[0.06] px-2.5 py-1.5">{processingTime ? `${processingTime} ms` : '0 ms'}</span>
                <span className="rounded bg-white/[0.06] px-2.5 py-1.5">{fps ? `${fps} FPS` : 'FPS --'}</span>
              </div>
            </div>

            <div className="checkerboard grid min-h-[300px] place-items-center bg-slate-950 p-2 sm:min-h-[440px]">
              <canvas
                ref={outputCanvasRef}
                className="max-h-[72vh] w-full rounded bg-slate-900 object-contain"
                style={{ aspectRatio: `${canvasSize.width} / ${canvasSize.height}` }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <MonitorPlay size={18} className="text-cyan-200" />
                {modeLabels[settings.mode]} · Pro · {canvasSize.width} x {canvasSize.height}
              </div>
              <div className="flex gap-2">
                {source !== 'video' && (
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center gap-2 rounded border border-white/10 bg-white/[0.05] px-3 text-sm font-semibold text-slate-100 transition hover:bg-white/[0.1]"
                    onClick={toggleVideoPlayback}
                    disabled={source === 'image'}
                  >
                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex min-h-10 items-center gap-2 rounded bg-cyan-300 px-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-200"
                  onClick={downloadSnapshot}
                >
                  <Download size={16} />
                  Snapshot
                </button>
              </div>
            </div>

            {source === 'video' && (
              <div className="grid gap-3 border-t border-white/10 bg-slate-950/80 px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="grid h-10 w-10 place-items-center rounded border border-white/10 bg-white/[0.05] text-slate-100 transition hover:bg-white/[0.1]"
                    title="Back 5 seconds"
                    onClick={() => seekVideoBy(-5)}
                  >
                    <SkipBack size={17} />
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center gap-2 rounded border border-white/10 bg-white/[0.05] px-3 text-sm font-semibold text-slate-100 transition hover:bg-white/[0.1]"
                    onClick={toggleVideoPlayback}
                  >
                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button
                    type="button"
                    className="grid h-10 w-10 place-items-center rounded border border-white/10 bg-white/[0.05] text-slate-100 transition hover:bg-white/[0.1]"
                    title="Forward 5 seconds"
                    onClick={() => seekVideoBy(5)}
                  >
                    <SkipForward size={17} />
                  </button>
                  <span className="ml-auto rounded bg-white/[0.06] px-2.5 py-1.5 text-xs font-semibold text-slate-300">
                    {formatTime(videoCurrentTime)} / {formatTime(videoDuration)}
                  </span>
                </div>
                <input
                  className="h-2 w-full cursor-pointer"
                  type="range"
                  min={0}
                  max={videoDuration || 0}
                  step={0.05}
                  value={Math.min(videoCurrentTime, videoDuration || 0)}
                  onChange={(event) => scrubVideoTo(Number(event.target.value))}
                  disabled={!videoDuration}
                />
              </div>
            )}
          </div>
        </section>

        <aside className="rounded border border-white/10 bg-slate-950/78 p-4 shadow-panel lg:sticky lg:top-5 lg:self-start">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={19} className="text-cyan-200" />
              <h2 className="text-lg font-bold text-white">Controls</h2>
            </div>
            <button
              type="button"
              className="grid h-9 w-9 place-items-center rounded border border-white/10 bg-white/[0.04] text-slate-200 transition hover:bg-white/[0.1]"
              title="Reset settings"
              onClick={resetSettings}
            >
              <RotateCcw size={16} />
            </button>
          </div>

          <div className="grid gap-3">
            <label className="grid gap-2 rounded border border-white/10 bg-white/[0.04] p-3">
              <span className="text-sm text-slate-200">Filter Mode</span>
              <select
                className="min-h-10 rounded border border-white/10 bg-slate-950 px-3 text-sm font-semibold text-white outline-none focus:border-cyan-300"
                value={settings.mode}
                onChange={(event) => setSettings((current) => ({ ...current, mode: event.target.value }))}
              >
                <option value="cartoon">Cartoon</option>
                <option value="pencil">Pencil Sketch</option>
                <option value="popart">Pop-Art</option>
              </select>
            </label>

            {settings.mode === 'cartoon' && (
              <label className="grid gap-2 rounded border border-white/10 bg-white/[0.04] p-3">
                <span className="text-sm text-slate-200">Cartoon Smoothing</span>
                <select
                  className="min-h-10 rounded border border-white/10 bg-slate-950 px-3 text-sm font-semibold text-white outline-none focus:border-cyan-300"
                  value={settings.cartoonSmoothingMode}
                  onChange={(event) => setSettings((current) => ({ ...current, cartoonSmoothingMode: event.target.value }))}
                >
                  <option value="lut-only">Lookup Table Only</option>
                  <option value="single-bilateral">1 Bilateral Pass</option>
                  <option value="double-bilateral">2 Bilateral Passes</option>
                </select>
              </label>
            )}

            <Slider
              label="Bilateral Smoothing"
              min={5}
              max={15}
              value={settings.bilateralDiameter}
              onChange={(value) => setSettings((current) => ({ ...current, bilateralDiameter: value }))}
            />
            <Slider
              label="Edge Thickness"
              min={1}
              max={7}
              step={1}
              value={settings.edgeBlockSize}
              onChange={(value) => setSettings((current) => ({ ...current, edgeBlockSize: value }))}
            />
            <Slider
              label="Edge Intensity"
              min={2}
              max={10}
              value={settings.edgeIntensity}
              onChange={(value) => setSettings((current) => ({ ...current, edgeIntensity: value }))}
            />
            <Slider
              label="Color Quantization"
              min={4}
              max={32}
              value={settings.colorQuantization}
              onChange={(value) => setSettings((current) => ({ ...current, colorQuantization: value }))}
            />
            <Slider
              label="Dot / Grid Size"
              min={4}
              max={20}
              value={settings.dotSize}
              onChange={(value) => setSettings((current) => ({ ...current, dotSize: value }))}
            />
          </div>
        </aside>
      </div>

      <canvas ref={sourceCanvasRef} className="hidden" />
      <video ref={videoRef} className="hidden" playsInline muted />
      <img ref={imageRef} alt="" className="hidden" />
      <input
        ref={imageInputRef}
        className="hidden"
        type="file"
        accept="image/*"
        onChange={(event) => handleImageUpload(event.target.files?.[0])}
      />
      <input
        ref={videoInputRef}
        className="hidden"
        type="file"
        accept="video/*"
        onChange={(event) => handleVideoUpload(event.target.files?.[0])}
      />
    </main>
  );
}
