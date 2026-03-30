import {
  detectFaceLandmarks,
  detectVideoFaceLandmarks,
  warmupFaceLandmarker,
  warmupVideoFaceLandmarker,
} from "./face-landmarks.js";
import { CONTROL_POINT_COUNT, MORPH_SIZE, createFaceMorph } from "./morph.js";

const PREVIEW_BACKGROUND = "#fbf2e6";
const PREVIEW_TEXT = "#6a5d51";
const LIVE_MORPH_SIZE = 384;
const LIVE_TRACKING_FPS = 6;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];

const state = {
  source: createSlotState(),
  target: createSlotState(),
  camera: {
    activeSlot: null,
    stream: null,
    tracking: false,
    frameHandle: null,
    lastTrackedAt: 0,
    processing: false,
    liveFrame: null,
  },
  lastMorphCanvas: null,
  busy: false,
};

const elements = {
  blendSlider: document.querySelector("#blendSlider"),
  blendValue: document.querySelector("#blendValue"),
  runMorphButton: document.querySelector("#runMorphButton"),
  swapFacesButton: document.querySelector("#swapFacesButton"),
  downloadButton: document.querySelector("#downloadButton"),
  statusBadge: document.querySelector("#statusBadge"),
  statusText: document.querySelector("#statusText"),
  sourcePreview: document.querySelector("#sourcePreview"),
  targetPreview: document.querySelector("#targetPreview"),
  sourceUpload: document.querySelector("#sourceUpload"),
  targetUpload: document.querySelector("#targetUpload"),
  cameraPanel: document.querySelector("#cameraPanel"),
  cameraTitle: document.querySelector("#cameraTitle"),
  cameraSlotChip: document.querySelector("#cameraSlotChip"),
  cameraFeed: document.querySelector("#cameraFeed"),
  cameraPreviewCanvas: document.querySelector("#cameraPreviewCanvas"),
  cameraStatus: document.querySelector("#cameraStatus"),
  toggleTrackingButton: document.querySelector("#toggleTrackingButton"),
  captureButton: document.querySelector("#captureButton"),
  closeCameraButton: document.querySelector("#closeCameraButton"),
  outputCanvas: document.querySelector("#outputCanvas"),
  transportSummary: document.querySelector("#transportSummary"),
  metricPoints: document.querySelector("#metricPoints"),
  metricIterations: document.querySelector("#metricIterations"),
  metricActivePairs: document.querySelector("#metricActivePairs"),
  metricDrift: document.querySelector("#metricDrift"),
};

initialize();

async function initialize() {
  drawEmptyPreview(elements.sourcePreview, "Load Face A");
  drawEmptyPreview(elements.targetPreview, "Load Face B");
  drawCameraPlaceholder("Open the camera to start live face tracking.");
  drawEmptyOutput();
  elements.metricPoints.textContent = String(CONTROL_POINT_COUNT);
  elements.blendValue.textContent = `${elements.blendSlider.value}%`;

  bindSlotUpload("source", elements.sourceUpload, elements.sourcePreview);
  bindSlotUpload("target", elements.targetUpload, elements.targetPreview);
  bindDragAndDrop("source");
  bindDragAndDrop("target");

  elements.blendSlider.addEventListener("input", () => {
    elements.blendValue.textContent = `${elements.blendSlider.value}%`;
  });

  elements.runMorphButton.addEventListener("click", buildMorph);
  elements.swapFacesButton.addEventListener("click", swapFaces);
  elements.downloadButton.addEventListener("click", downloadMorph);
  elements.captureButton.addEventListener("click", captureCameraFrame);
  elements.toggleTrackingButton.addEventListener("click", toggleLiveTracking);
  elements.closeCameraButton.addEventListener("click", closeCamera);

  document.querySelectorAll("[data-open-camera]").forEach((button) => {
    button.addEventListener("click", () => openCamera(button.dataset.openCamera));
  });

  document.querySelectorAll("[data-clear-slot]").forEach((button) => {
    button.addEventListener("click", () => clearSlot(button.dataset.clearSlot));
  });

  try {
    setStatus("Loading face landmark models...", "info");
    await Promise.all([warmupFaceLandmarker(), warmupVideoFaceLandmarker()]);
    setStatus("Ready. Upload stills or use the camera for live tracking.", "success");
  } catch (error) {
    console.error(error);
    setStatus("Model loading failed. Check your internet connection and reload.", "error");
  }
}

function createSlotState() {
  return {
    normalizedCanvas: null,
    liveCanvas: null,
    landmarks: null,
    label: "",
  };
}

function bindSlotUpload(slot, input, previewCanvas) {
  input.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      await processFile(slot, file);
    } finally {
      input.value = "";
      renderSlotPreview(slot, previewCanvas);
    }
  });
}

function bindDragAndDrop(slot) {
  const panel = document.querySelector(`.face-panel[data-slot="${slot}"]`);

  ["dragenter", "dragover"].forEach((eventName) => {
    panel.addEventListener(eventName, (event) => {
      event.preventDefault();
      panel.classList.add("drag-active");
    });
  });

  ["dragleave", "dragend", "drop"].forEach((eventName) => {
    panel.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName !== "drop") {
        panel.classList.remove("drag-active");
      }
    });
  });

  panel.addEventListener("drop", async (event) => {
    panel.classList.remove("drag-active");
    const file = event.dataTransfer?.files?.[0];

    if (file && isImageFile(file)) {
      await processFile(slot, file);
      renderSlotPreview(slot, slot === "source" ? elements.sourcePreview : elements.targetPreview);
      return;
    }

    setStatus("That file does not look like a supported image.", "error");
  });
}

async function processFile(slot, file) {
  const label = file.name || `${slot}.image`;
  const rawCanvas = await fileToCanvas(file);
  await processCanvas(slot, rawCanvas, label);
}

async function processCanvas(slot, rawCanvas, label) {
  if (state.busy) {
    setStatus("Please wait for the current task to finish.", "info");
    return;
  }

  setBusy(true);
  setStatus(`Analyzing ${slotLabel(slot)}...`, "info");

  try {
    const initialLandmarks = await detectFaceLandmarks(rawCanvas);
    const normalizedFrame = normalizeFaceSource(rawCanvas, initialLandmarks, MORPH_SIZE);

    state[slot] = {
      normalizedCanvas: normalizedFrame.canvas,
      liveCanvas: resizeCanvas(normalizedFrame.canvas, LIVE_MORPH_SIZE),
      landmarks: normalizedFrame.landmarks,
      label,
    };

    renderSlotPreview(slot, slot === "source" ? elements.sourcePreview : elements.targetPreview);
    setStatus(`${slotLabel(slot)} ready. ${missingSlotMessage()}`, "success");
  } catch (error) {
    console.error(error);
    setStatus(`${slotLabel(slot)} could not be processed: ${error.message}`, "error");
    clearSlot(slot, false);
  } finally {
    setBusy(false);
  }
}

async function openCamera(slot) {
  if (state.busy) {
    setStatus("Please wait for the current task to finish.", "info");
    return;
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera access.");
    }

    closeCamera(false);
    state.camera.activeSlot = slot;
    state.camera.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    elements.cameraFeed.srcObject = state.camera.stream;
    elements.cameraPanel.classList.remove("hidden");
    elements.cameraTitle.textContent = `Live ${slotLabel(slot)}`;
    elements.cameraSlotChip.textContent = `${slotLabel(slot)} live`;
    elements.cameraStatus.textContent = `Starting live tracking for ${slotLabel(slot)}...`;
    drawCameraPlaceholder("Starting live camera...");
    await warmupVideoFaceLandmarker();
    await elements.cameraFeed.play();
    startLiveTracking();
    setStatus(`Camera open for ${slotLabel(slot)}. Live tracking is active.`, "success");
  } catch (error) {
    console.error(error);
    setStatus(`Camera could not start: ${error.message}`, "error");
  }
}

function startLiveTracking() {
  if (!state.camera.stream || state.camera.tracking) {
    return;
  }

  state.camera.tracking = true;
  state.camera.lastTrackedAt = 0;
  state.camera.liveFrame = null;
  elements.toggleTrackingButton.textContent = "Pause Live Tracking";
  elements.cameraStatus.textContent = liveTrackingStatusText();
  state.camera.frameHandle = requestAnimationFrame(trackCameraFrame);
}

function pauseLiveTracking() {
  state.camera.tracking = false;
  state.camera.processing = false;
  state.camera.liveFrame = null;

  if (state.camera.frameHandle) {
    cancelAnimationFrame(state.camera.frameHandle);
    state.camera.frameHandle = null;
  }

  elements.toggleTrackingButton.textContent = "Start Live Tracking";
  if (state.camera.stream) {
    elements.cameraStatus.textContent = "Live tracking paused. You can resume it or capture a still frame.";
  }
}

function toggleLiveTracking() {
  if (!state.camera.stream) {
    setStatus("Open the camera before starting live tracking.", "info");
    return;
  }

  if (state.camera.tracking) {
    pauseLiveTracking();
    return;
  }

  startLiveTracking();
}

async function trackCameraFrame(timestamp) {
  if (!state.camera.tracking) {
    return;
  }

  if (state.busy) {
    state.camera.frameHandle = requestAnimationFrame(trackCameraFrame);
    return;
  }

  if (timestamp - state.camera.lastTrackedAt < 1000 / LIVE_TRACKING_FPS) {
    state.camera.frameHandle = requestAnimationFrame(trackCameraFrame);
    return;
  }

  if (state.camera.processing || elements.cameraFeed.readyState < 2) {
    state.camera.frameHandle = requestAnimationFrame(trackCameraFrame);
    return;
  }

  state.camera.processing = true;
  state.camera.lastTrackedAt = timestamp;

  try {
    const liveLandmarks = await detectVideoFaceLandmarks(elements.cameraFeed, timestamp);
    drawTrackedCameraPreview(elements.cameraFeed, liveLandmarks);

    if (!liveLandmarks) {
      elements.cameraStatus.textContent = "No face detected in the live feed yet.";
      state.camera.liveFrame = null;
      state.camera.frameHandle = requestAnimationFrame(trackCameraFrame);
      return;
    }

    const liveFrame = normalizeFaceSource(elements.cameraFeed, liveLandmarks, LIVE_MORPH_SIZE);
    state.camera.liveFrame = liveFrame;
    renderLiveSlotPreview(state.camera.activeSlot, liveFrame);
    elements.cameraStatus.textContent = liveTrackingStatusText();
    await renderLiveMorph(liveFrame);
  } catch (error) {
    console.error(error);
    elements.cameraStatus.textContent = `Live tracking error: ${error.message}`;
  } finally {
    state.camera.processing = false;
    if (state.camera.tracking) {
      state.camera.frameHandle = requestAnimationFrame(trackCameraFrame);
    }
  }
}

async function renderLiveMorph(liveFrame) {
  const liveSlot = state.camera.activeSlot;
  const staticSlot = liveSlot === "source" ? "target" : "source";

  if (!state[staticSlot].liveCanvas || !state[staticSlot].landmarks) {
    elements.transportSummary.textContent = `Live tracking active. Load ${slotLabel(staticSlot)} to morph in real time.`;
    return;
  }

  const alpha = Number(elements.blendSlider.value) / 100;
  const result = await createFaceMorph({
    sourceCanvas: liveSlot === "source" ? liveFrame.canvas : state.source.liveCanvas,
    targetCanvas: liveSlot === "source" ? state.target.liveCanvas : liveFrame.canvas,
    sourceLandmarks: liveSlot === "source" ? liveFrame.landmarks : state.source.landmarks,
    targetLandmarks: liveSlot === "source" ? state.target.landmarks : liveFrame.landmarks,
    alpha,
  });

  state.lastMorphCanvas = result.canvas;
  drawOutputCanvas(result.canvas);
  updateMetrics(result, true);
  elements.downloadButton.disabled = false;
}

async function captureCameraFrame() {
  const slot = state.camera.activeSlot;
  const video = elements.cameraFeed;

  if (!slot || !state.camera.stream || !video.videoWidth || !video.videoHeight) {
    setStatus("The camera feed is not ready yet.", "info");
    return;
  }

  pauseLiveTracking();

  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  const context = captureCanvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
  context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

  await processCanvas(slot, captureCanvas, `${slotLabel(slot)} live capture`);
  closeCamera(false);
}

function closeCamera(updateStatus = true) {
  pauseLiveTracking();

  if (state.camera.stream) {
    state.camera.stream.getTracks().forEach((track) => track.stop());
  }

  state.camera.stream = null;
  state.camera.activeSlot = null;
  elements.cameraFeed.srcObject = null;
  elements.cameraPanel.classList.add("hidden");
  elements.cameraStatus.textContent = "Open the camera to start live face tracking.";
  drawCameraPlaceholder("Open the camera to start live face tracking.");

  if (updateStatus && !state.busy) {
    setStatus("Camera closed.", "info");
  }
}

function clearSlot(slot, updateStatus = true) {
  state[slot] = createSlotState();
  renderSlotPreview(slot, slot === "source" ? elements.sourcePreview : elements.targetPreview);

  if (updateStatus) {
    setStatus(`${slotLabel(slot)} cleared. ${missingSlotMessage()}`, "info");
  }
}

function swapFaces() {
  if (state.busy) {
    setStatus("Please wait for the current task to finish.", "info");
    return;
  }

  if (state.camera.tracking) {
    setStatus("Close the camera before swapping source and target.", "info");
    return;
  }

  [state.source, state.target] = [state.target, state.source];
  renderSlotPreview("source", elements.sourcePreview);
  renderSlotPreview("target", elements.targetPreview);
  setStatus("Source and target swapped.", "success");
}

async function buildMorph() {
  if (state.busy) {
    return;
  }

  if (!state.source.normalizedCanvas || !state.target.normalizedCanvas) {
    setStatus("Load both Face A and Face B before morphing.", "error");
    return;
  }

  setBusy(true);
  elements.downloadButton.disabled = true;
  setStatus("Solving the transport plan and rendering the morph...", "info");

  try {
    const alpha = Number(elements.blendSlider.value) / 100;
    const result = await createFaceMorph({
      sourceCanvas: state.source.normalizedCanvas,
      targetCanvas: state.target.normalizedCanvas,
      sourceLandmarks: state.source.landmarks,
      targetLandmarks: state.target.landmarks,
      alpha,
    });

    state.lastMorphCanvas = result.canvas;
    drawOutputCanvas(result.canvas);
    updateMetrics(result, false);
    elements.downloadButton.disabled = false;
    setStatus(`Morph ready. Transport simplex converged in ${result.transport.iterations} iterations.`, "success");
  } catch (error) {
    console.error(error);
    setStatus(`Morphing failed: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

function downloadMorph() {
  if (!state.lastMorphCanvas) {
    setStatus("Build a morph before downloading.", "info");
    return;
  }

  const link = document.createElement("a");
  link.href = state.lastMorphCanvas.toDataURL("image/png");
  link.download = "deepfake-ot-morph.png";
  link.click();
}

function renderSlotPreview(slot, canvas) {
  const context = canvas.getContext("2d");
  const slotState = state[slot];
  const size = canvas.width;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PREVIEW_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (!slotState.normalizedCanvas) {
    drawEmptyPreview(canvas, slot === "source" ? "Load Face A" : "Load Face B");
    return;
  }

  context.drawImage(slotState.normalizedCanvas, 0, 0, size, size);
  drawLandmarkOverlay(context, slotState.landmarks, size);
  drawPreviewLabel(context, size, slotState.label);
}

function renderLiveSlotPreview(slot, liveFrame) {
  const canvas = slot === "source" ? elements.sourcePreview : elements.targetPreview;
  const context = canvas.getContext("2d");
  const size = canvas.width;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PREVIEW_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(liveFrame.canvas, 0, 0, size, size);
  drawLandmarkOverlay(context, liveFrame.landmarks, size);
  drawPreviewLabel(context, size, `${slotLabel(slot)} live`);
}

function drawLandmarkOverlay(context, landmarks, size) {
  context.save();
  context.fillStyle = "rgba(221, 90, 44, 0.85)";

  landmarks.forEach((landmark) => {
    context.beginPath();
    context.arc(landmark.x * size, landmark.y * size, 1.2, 0, Math.PI * 2);
    context.fill();
  });

  context.restore();
}

function drawPreviewLabel(context, size, label) {
  if (!label) {
    return;
  }

  context.fillStyle = "rgba(20, 15, 10, 0.62)";
  context.fillRect(14, size - 48, size - 28, 34);
  context.fillStyle = "#fff8ef";
  context.textAlign = "left";
  context.font = '500 14px "Space Grotesk", sans-serif';
  context.fillText(label.slice(0, 42), 26, size - 25);
}

function drawTrackedCameraPreview(video, landmarks) {
  const canvas = elements.cameraPreviewCanvas;
  const context = canvas.getContext("2d");
  const fit = containRect(video.videoWidth, video.videoHeight, canvas.width, canvas.height);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PREVIEW_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.save();
  context.translate(fit.x + fit.width, fit.y);
  context.scale(-1, 1);
  context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, fit.width, fit.height);
  context.restore();

  context.strokeStyle = "rgba(33, 25, 19, 0.12)";
  context.strokeRect(fit.x, fit.y, fit.width, fit.height);

  if (!landmarks) {
    context.fillStyle = PREVIEW_TEXT;
    context.textAlign = "center";
    context.font = '700 16px "Space Grotesk", sans-serif';
    context.fillText("Looking for a face...", canvas.width / 2, canvas.height - 28);
    return;
  }

  context.fillStyle = "rgba(221, 90, 44, 0.9)";
  landmarks.forEach((landmark) => {
    const x = fit.x + (1 - landmark.x) * fit.width;
    const y = fit.y + landmark.y * fit.height;
    context.beginPath();
    context.arc(x, y, 1.3, 0, Math.PI * 2);
    context.fill();
  });
}

function drawCameraPlaceholder(message) {
  const canvas = elements.cameraPreviewCanvas;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PREVIEW_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PREVIEW_TEXT;
  context.textAlign = "center";
  context.font = '700 20px "Space Grotesk", sans-serif';
  context.fillText("Live Camera Preview", canvas.width / 2, canvas.height / 2 - 10);
  context.font = '400 14px "Space Grotesk", sans-serif';
  context.fillText(message, canvas.width / 2, canvas.height / 2 + 22);
}

function drawEmptyPreview(canvas, label) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = PREVIEW_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "rgba(106, 93, 81, 0.24)";
  context.setLineDash([8, 10]);
  context.lineWidth = 2;
  context.strokeRect(28, 28, canvas.width - 56, canvas.height - 56);

  context.setLineDash([]);
  context.fillStyle = PREVIEW_TEXT;
  context.textAlign = "center";
  context.font = '700 18px "Space Grotesk", sans-serif';
  context.fillText(label, canvas.width / 2, canvas.height / 2 - 10);
  context.font = '400 14px "Space Grotesk", sans-serif';
  context.fillText("Drop, upload, or use camera", canvas.width / 2, canvas.height / 2 + 22);
}

function drawEmptyOutput() {
  const context = elements.outputCanvas.getContext("2d");
  context.clearRect(0, 0, elements.outputCanvas.width, elements.outputCanvas.height);
  context.fillStyle = PREVIEW_BACKGROUND;
  context.fillRect(0, 0, elements.outputCanvas.width, elements.outputCanvas.height);
  context.fillStyle = PREVIEW_TEXT;
  context.textAlign = "center";
  context.font = '700 22px "Space Grotesk", sans-serif';
  context.fillText("Morph preview", elements.outputCanvas.width / 2, elements.outputCanvas.height / 2 - 8);
  context.font = '400 15px "Space Grotesk", sans-serif';
  context.fillText("Load two faces or start the live camera feed", elements.outputCanvas.width / 2, elements.outputCanvas.height / 2 + 22);
}

function drawOutputCanvas(canvas) {
  const outputContext = elements.outputCanvas.getContext("2d");
  outputContext.clearRect(0, 0, elements.outputCanvas.width, elements.outputCanvas.height);
  outputContext.drawImage(canvas, 0, 0, elements.outputCanvas.width, elements.outputCanvas.height);
}

function updateMetrics(result, isLive) {
  elements.transportSummary.textContent = isLive
    ? `Live OT | Cost ${result.transport.totalCost.toFixed(3)} | ${result.transport.activePairs} active flows`
    : `Cost ${result.transport.totalCost.toFixed(3)} | ${result.transport.activePairs} active flows`;
  elements.metricPoints.textContent = String(result.controlPointCount);
  elements.metricIterations.textContent = String(result.transport.iterations);
  elements.metricActivePairs.textContent = String(result.transport.activePairs);
  elements.metricDrift.textContent = `${result.transport.meanDrift.toFixed(1)} px`;
}

function normalizeFaceSource(source, landmarks, outputSize) {
  const { width, height } = sourceDimensions(source);
  const crop = computeFaceCrop(landmarks, width, height);
  const canvas = document.createElement("canvas");

  canvas.width = outputSize;
  canvas.height = outputSize;

  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputSize, outputSize);
  context.drawImage(source, crop.x, crop.y, crop.size, crop.size, 0, 0, outputSize, outputSize);

  const normalizedLandmarks = landmarks.map((landmark) => ({
    x: clamp((landmark.x * width - crop.x) / crop.size, 0, 1),
    y: clamp((landmark.y * height - crop.y) / crop.size, 0, 1),
    z: landmark.z ?? 0,
  }));

  return {
    canvas,
    landmarks: normalizedLandmarks,
    crop,
  };
}

function computeFaceCrop(landmarks, width, height) {
  const facePoints = landmarks.map((landmark) => ({
    x: landmark.x * width,
    y: landmark.y * height,
  }));
  const xs = facePoints.map((point) => point.x);
  const ys = facePoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const faceWidth = maxX - minX;
  const faceHeight = maxY - minY;
  const side = Math.max(faceWidth, faceHeight) * 1.85;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2 - side * 0.06;
  const unclampedX = centerX - side / 2;
  const unclampedY = centerY - side / 2;
  const x = clamp(unclampedX, 0, Math.max(0, width - side));
  const y = clamp(unclampedY, 0, Math.max(0, height - side));
  const size = Math.min(side, width - x, height - y);

  return { x, y, size };
}

function resizeCanvas(sourceCanvas, outputSize) {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  canvas.getContext("2d").drawImage(sourceCanvas, 0, 0, outputSize, outputSize);
  return canvas;
}

async function fileToCanvas(file) {
  const source = await decodeImageFile(file);
  const canvas = document.createElement("canvas");
  const { width, height } = sourceDimensions(source);
  const maxDimension = 2048;
  const scale = Math.min(1, maxDimension / Math.max(width, height));

  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height);

  if (typeof source.close === "function") {
    source.close();
  }

  return canvas;
}

async function decodeImageFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      return fileToImage(file);
    }
  }

  return fileToImage(file);
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The selected image could not be decoded."));
    };

    image.src = url;
  });
}

function sourceDimensions(source) {
  if ("videoWidth" in source && source.videoWidth) {
    return { width: source.videoWidth, height: source.videoHeight };
  }

  return {
    width: source.naturalWidth ?? source.width,
    height: source.naturalHeight ?? source.height,
  };
}

function containRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const x = (targetWidth - width) / 2;
  const y = (targetHeight - height) / 2;
  return { x, y, width, height };
}

function isImageFile(file) {
  return (
    (file.type && file.type.startsWith("image/")) ||
    IMAGE_EXTENSIONS.some((extension) => file.name?.toLowerCase().endsWith(extension))
  );
}

function liveTrackingStatusText() {
  const liveSlot = state.camera.activeSlot;
  const staticSlot = liveSlot === "source" ? "target" : "source";

  if (!state[staticSlot].liveCanvas) {
    return `Tracking ${slotLabel(liveSlot)} live. Load ${slotLabel(staticSlot)} to see a real-time morph.`;
  }

  return `Tracking ${slotLabel(liveSlot)} live and morphing against ${slotLabel(staticSlot)}.`;
}

function setStatus(message, tone) {
  elements.statusText.textContent = message;
  elements.statusBadge.textContent = tone === "success" ? "Ready" : tone === "error" ? "Attention" : "Working";
  elements.statusBadge.className = `status-badge ${tone}`;
}

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.runMorphButton.disabled = isBusy;
  elements.swapFacesButton.disabled = isBusy;
  elements.captureButton.disabled = isBusy;
  elements.toggleTrackingButton.disabled = isBusy;
}

function missingSlotMessage() {
  if (!state.source.normalizedCanvas && !state.target.normalizedCanvas) {
    return "Load both faces to continue.";
  }

  if (!state.source.normalizedCanvas) {
    return "Face A is still missing.";
  }

  if (!state.target.normalizedCanvas) {
    return "Face B is still missing.";
  }

  return "Both faces are loaded. Click Build Morph or use live tracking.";
}

function slotLabel(slot) {
  return slot === "source" ? "Face A" : "Face B";
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
