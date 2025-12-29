/**
 * Roboflow WebRTC Secure Streaming - Frontend
 *
 * This example uses connectors.withProxyUrl() to keep your API key secure.
 * All communication with Roboflow is proxied through the backend server.
 */

import {connectors, streams, webrtc} from '@roboflow/inference-sdk';

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const videoEl = document.getElementById("video");
const dataPreviewEl = document.getElementById("dataPreview");
const dataCountEl = document.getElementById("dataCount");

const levelsTextEl = document.getElementById("levelsText");
const scoreByTrack = new Map(); // track_id -> last known score (number)
const bottleTableBodyEl = document.getElementById("bottleTableBody");


const bottlesByColor = new Map();
const BOTTLE_CAPACITY_LITERS = 1.0;
const HISTORY_SIZE = 10; // Number of recent values to make average

let dataMessageCount = 0;

const configInputs = {
    imageInputName: document.getElementById("imageInputName"),
    streamOutputNames: document.getElementById("streamOutputNames"),
    dataOutputNames: document.getElementById("dataOutputNames")
};

// Config inputs - Server settings
const serverInputs = {
    requestedRegion: document.getElementById("requestedRegion"),
    requestedPlan: document.getElementById("requestedPlan"),
    processingTimeout: document.getElementById("processingTimeout")
};

// Tab elements
const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");

// Current workflow mode: "workflow_defined" or "local_defined"
let workflowMode = "workflow_defined";

// Config inputs - Camera
const cameraInputs = {
    cameraSelect: document.getElementById("cameraSelect"),
    resolutionSelect: document.getElementById("resolutionSelect"),
    fpsSelect: document.getElementById("fpsSelect"),
    cameraCaps: document.getElementById("cameraCaps")
};

// Track active connection
let activeConnection = null;

// Store camera capabilities
let cameraCapabilities = null;

/**
 * Get server configuration
 */
function getServerConfig() {
    return {
        requestedRegion: serverInputs.requestedRegion?.value || "eu",
        requestedPlan: serverInputs.requestedPlan?.value || "webrtc-gpu-small",
        processingTimeout: parseInt(serverInputs.processingTimeout?.value) || 30
    };
}

/**
 * Get current workflow configuration based on selected mode
 */
function getConfig() {
    const serverConfig = getServerConfig();
    console.log("Selected mode: ", workflowMode)
    const workspaceName = "workspace-hh1bb";
    const workflowId = "water-project2";

    return {
        mode: "custom",
        workspaceName,
        workflowId,
        imageInputName: configInputs.imageInputName?.value?.trim() || "image",
        streamOutputNames: (configInputs.streamOutputNames?.value?.trim() || "output_image")
            .split(",").map(s => s.trim()).filter(Boolean),
        dataOutputNames: (configInputs.dataOutputNames?.value?.trim() || "percentage")
            .split(",").map(s => s.trim()).filter(Boolean),
        ...serverConfig
    };
}

/**
 * Switch workflow tab
 */
function switchTab(tabName) {
    workflowMode = tabName;
    tabBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    tabContents.forEach(content => content.classList.toggle("active", content.id === `tab-${tabName}`));
}

/**
 * Get current camera configuration from form inputs
 */
function getCameraConfig() {
    const resolution = cameraInputs.resolutionSelect?.value?.split("x") || [];
    const fps = parseInt(cameraInputs.fpsSelect?.value) || 30;

    return {
        deviceId: cameraInputs.cameraSelect?.value || undefined,
        width: resolution[0] ? parseInt(resolution[0]) : 640,
        height: resolution[1] ? parseInt(resolution[1]) : 480,
        frameRate: fps
    };
}

/**
 * Enumerate available video input devices (cameras)
 */
async function enumerateCameras() {
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({video: true});
        tempStream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter(device => device.kind === "videoinput");

        console.log("[Camera] Found devices:", cameras);

        cameraInputs.cameraSelect.innerHTML = "";

        if (cameras.length === 0) {
            cameraInputs.cameraSelect.innerHTML = '<option value="">No cameras found</option>';
            return;
        }

        cameras.forEach((camera, index) => {
            const option = document.createElement("option");
            option.value = camera.deviceId;
            option.textContent = camera.label || `Camera ${index + 1}`;
            cameraInputs.cameraSelect.appendChild(option);
        });

        cameraInputs.cameraSelect.disabled = false;

        if (cameras.length > 0) {
            await getCameraCapabilities(cameras[0].deviceId);
        }

    } catch (err) {
        console.error("[Camera] Failed to enumerate devices:", err);
        cameraInputs.cameraSelect.innerHTML = '<option value="">Camera access denied</option>';
        cameraInputs.cameraCaps.textContent = "Grant camera permission to see available devices";
    }
}

/**
 * Get capabilities (resolutions, frame rates) for a specific camera
 */
async function getCameraCapabilities(deviceId) {
    cameraInputs.cameraCaps.textContent = "Detecting capabilities...";
    cameraInputs.cameraCaps.classList.add("loading");
    cameraInputs.resolutionSelect.disabled = true;
    cameraInputs.fpsSelect.disabled = true;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {deviceId: {exact: deviceId}}
        });

        const track = stream.getVideoTracks()[0];
        const capabilities = track.getCapabilities();
        const settings = track.getSettings();

        console.log("[Camera] Capabilities:", capabilities);
        console.log("[Camera] Current settings:", settings);

        cameraCapabilities = capabilities;
        stream.getTracks().forEach(t => t.stop());

        populateResolutions(capabilities, settings);
        populateFrameRates(capabilities, settings);

        const summary = [];
        if (capabilities.width && capabilities.height) {
            summary.push(`${capabilities.width.min}×${capabilities.height.min} - ${capabilities.width.max}×${capabilities.height.max}`);
        }
        if (capabilities.frameRate) {
            summary.push(`${capabilities.frameRate.min}-${capabilities.frameRate.max} fps`);
        }
        cameraInputs.cameraCaps.textContent = summary.join(" • ") || "Capabilities detected";
        cameraInputs.cameraCaps.classList.remove("loading");
    } catch (err) {
        console.error("[Camera] Failed to get capabilities:", err);
        cameraInputs.cameraCaps.textContent = "Failed to detect capabilities";
        cameraInputs.cameraCaps.classList.remove("loading");
        setDefaultCameraOptions();
    }
}

/**
 * Generate common resolutions within camera capabilities
 */
function populateResolutions(capabilities, currentSettings) {
    const commonResolutions = [
        {w: 3840, h: 2160, label: "4K (3840×2160)"},
        {w: 2560, h: 1440, label: "QHD (2560×1440)"},
        {w: 1920, h: 1080, label: "1080p (1920×1080)"},
        {w: 1280, h: 720, label: "720p (1280×720)"},
        {w: 854, h: 480, label: "480p (854×480)"},
        {w: 640, h: 480, label: "VGA (640×480)"},
        {w: 640, h: 360, label: "360p (640×360)"},
        {w: 320, h: 240, label: "QVGA (320×240)"}
    ];

    cameraInputs.resolutionSelect.innerHTML = "";

    const maxW = capabilities.width?.max || 1920;
    const maxH = capabilities.height?.max || 1080;
    const minW = capabilities.width?.min || 320;
    const minH = capabilities.height?.min || 240;

    const availableResolutions = commonResolutions.filter(
        res => res.w >= minW && res.w <= maxW && res.h >= minH && res.h <= maxH
    );

    const maxIsStandard = availableResolutions.some(r => r.w === maxW && r.h === maxH);
    if (!maxIsStandard && maxW && maxH) {
        availableResolutions.unshift({w: maxW, h: maxH, label: `Max (${maxW}×${maxH})`});
    }

    if (availableResolutions.length === 0) {
        availableResolutions.push({w: 640, h: 480, label: "VGA (640×480)"});
    }

    availableResolutions.forEach(res => {
        const option = document.createElement("option");
        option.value = `${res.w}x${res.h}`;
        option.textContent = res.label;
        cameraInputs.resolutionSelect.appendChild(option);
    });

    const currentRes = `${currentSettings.width}x${currentSettings.height}`;
    const hasCurrentRes = availableResolutions.some(r => `${r.w}x${r.h}` === currentRes);

    if (hasCurrentRes) {
        cameraInputs.resolutionSelect.value = currentRes;
    } else {
        const default720 = availableResolutions.find(r => r.w === 1280 && r.h === 720);
        if (default720) {
            cameraInputs.resolutionSelect.value = "1280x720";
        }
    }

    cameraInputs.resolutionSelect.disabled = false;
}

/**
 * Generate frame rate options within camera capabilities
 */
function populateFrameRates(capabilities, currentSettings) {
    const commonFps = [60, 30, 24, 15, 10];

    cameraInputs.fpsSelect.innerHTML = "";

    const maxFps = capabilities.frameRate?.max || 30;
    const minFps = capabilities.frameRate?.min || 1;

    const availableFps = commonFps.filter(fps => fps >= minFps && fps <= maxFps);

    if (!availableFps.includes(Math.floor(maxFps)) && maxFps > 0) {
        availableFps.unshift(Math.floor(maxFps));
    }
    availableFps.sort((a, b) => b - a);

    if (availableFps.length === 0) {
        availableFps.push(30);
    }

    availableFps.forEach(fps => {
        const option = document.createElement("option");
        option.value = fps;
        option.textContent = `${fps} fps`;
        cameraInputs.fpsSelect.appendChild(option);
    });

    const currentFps = Math.round(currentSettings.frameRate);
    if (availableFps.includes(currentFps)) {
        cameraInputs.fpsSelect.value = currentFps;
    } else if (availableFps.includes(30)) {
        cameraInputs.fpsSelect.value = 30;
    }

    cameraInputs.fpsSelect.disabled = false;
}

/**
 * Set default camera options when capabilities can't be detected
 */
function setDefaultCameraOptions() {
    cameraInputs.resolutionSelect.innerHTML = `
      <option value="1920x1080">1080p (1920×1080)</option>
      <option value="1280x720" selected>720p (1280×720)</option>
      <option value="640x480">VGA (640×480)</option>
    `;
    cameraInputs.fpsSelect.innerHTML = `
      <option value="30" selected>30 fps</option>
      <option value="24">24 fps</option>
      <option value="15">15 fps</option>
    `;
    cameraInputs.resolutionSelect.disabled = false;
    cameraInputs.fpsSelect.disabled = false;
}


// Workflow specification
const WORKFLOW_SPEC = {}

/**
 * Update status display
 */
function setStatus(text) {
    statusEl.textContent = text;
    console.log("[UI Status]", text);
}

function toNumberOrNull(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}


/**
 * Connect to Roboflow WebRTC streaming using secure proxy
 *
 * @param {Object} options - Connection options
 * @param {Object} [options.workflowSpec] - Workflow specification
 * @param {Function} [options.onData] - Callback for data channel messages
 * @returns {Promise<RFWebRTCConnection>} WebRTC connection object
 */
async function connectWebcamToRoboflowWebRTC(options = {}) {
    const {onData} = options;
    const config = getConfig();
    const cameraConfig = getCameraConfig();

    console.log("[Config] Workflow:", config);
    console.log("[Config] Camera:", cameraConfig);

    const connector = connectors.withProxyUrl('/api/init-webrtc', {
        turnConfigUrl: '/api/turn-config'
    });
    const videoConstraints = {
        width: {ideal: cameraConfig.width},
        height: {ideal: cameraConfig.height},
        frameRate: {ideal: cameraConfig.frameRate, max: cameraConfig.frameRate}
    };
    if (cameraConfig.deviceId) {
        videoConstraints.deviceId = {exact: cameraConfig.deviceId};
    } else {
        videoConstraints.facingMode = {ideal: "environment"};
    }

    const baseParams = {
        imageInputName: config.imageInputName,
        streamOutputNames: config.streamOutputNames,
        dataOutputNames: config.dataOutputNames,
        requestedRegion: config.requestedRegion,
        requestedPlan: config.requestedPlan,
        processingTimeout: config.processingTimeout
    };

    // local_defined, workflow_defined
    const wrtcParams = config.mode === "local_defined"
        ? {...baseParams, workflowSpec: WORKFLOW_SPEC}
        : {...baseParams, workspaceName: "workspace-hh1bb", workflowId: "water-project2"};

    const connection = await webrtc.useStream({
        source: await streams.useCamera({
            video: videoConstraints,
            audio: false
        }),
        connector: connector,
        wrtcParams: wrtcParams,
        onData: onData,
        options: {
            disableInputStreamDownscaling: true
        }
    });

    return connection;
}

/**
 * Calculate average with outlier removal
 * Returns { average, filteredHistory, removedCount }
 */
function calculateFilteredAverage(history) {
    const n = history.length;
    if (n === 0) {
        return {average: null, filteredHistory: [], removedCount: 0};
    }
    if (n < 10) {
        const average = history.reduce((a, b) => a + b, 0) / n;
        return {average, filteredHistory: history, removedCount: 0};
    }

    const mean = history.reduce((s, v) => s + v, 0) / n;
    const stdDev = Math.sqrt(
        history.reduce((s, v) => s + (v - mean) ** 2, 0) / n
    );
    const threshold = 2 * stdDev;
    const filteredHistory = history.filter(
        v => Math.abs(v - mean) <= threshold
    );

    const removedCount = n - filteredHistory.length;
    const average =
        filteredHistory.length === 0
            ? null
            : filteredHistory.reduce((s, v) => s + v, 0) / filteredHistory.length;
    return {average, filteredHistory, removedCount};
}


/**
 * Update the bottle consumption table
 */
function updateBottleTable() {
    if (!bottleTableBodyEl) return;

    if (bottlesByColor.size === 0) {
        bottleTableBodyEl.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; opacity: 0.5; padding: 20px;">
            Waiting for data...
          </td>
        </tr>
      `;
        return;
    }

    // sorting for having always the same list...
    const sortedBottles = Array.from(bottlesByColor.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
    );

    bottleTableBodyEl.innerHTML = sortedBottles.map(([color, bottle]) => {
        const history = bottle.percentHistory.filter(v => typeof v === 'number' && !isNaN(v));
        const hasValidData = history.length > 0;
        const filteredResult = hasValidData ? calculateFilteredAverage(history) : {
            average: null,
            filteredHistory: [],
            removedCount: 0
        };
        const avgCurrentPercent = filteredResult.average;

        // Log the values being averaged
        if (hasValidData) {
            const maxAvgInfo = bottle.maxAvgPercent !== null
                ? ` | Max Avg (10+ values): ${bottle.maxAvgPercent.toFixed(1)}%`
                : ` | Max Avg: Not available yet (need ${HISTORY_SIZE} values)`;

            const historyFormatted = history.map(v => v.toFixed(1)).join(', ');
            const filterInfo = filteredResult.removedCount > 0
                ? ` (filtered: removed ${filteredResult.removedCount} outlier(s) from first 8, kept last 2)`
                : '';
            const filteredFormatted = filteredResult.filteredHistory.map(v => v.toFixed(1)).join(', ');

            console.log(`[Average] ${color} bottle - Last ${history.length} values:`, historyFormatted);
            if (filteredResult.removedCount > 0) {
                console.log(`  - After filtering (${filteredResult.filteredHistory.length} values):`, filteredFormatted);
            }
            console.log(`  - Average: ${avgCurrentPercent.toFixed(1)}%${filterInfo}${maxAvgInfo}`);
        } else {
            console.log(`[Average] ${color} bottle - No valid data (unknown)`);
        }

        // Percentage consumed is based on max average when we have at least 10 values
        let consumedPercent = null;
        let consumedLiters = null;
        if (hasValidData && bottle.maxAvgPercent !== null) {
            consumedPercent = Math.max(0, bottle.maxAvgPercent - avgCurrentPercent);
            consumedLiters = (consumedPercent / 100) * bottle.capacity;
        }

        return `
        <tr>
          <td class="bottle-color">${color}</td>
          <td class="percentage">${hasValidData ? avgCurrentPercent.toFixed(1) + '%' : 'unknown'}</td>
          <td class="percentage consumed">${consumedPercent !== null ? consumedPercent.toFixed(1) + '%' : 'unknown'}</td>
          <td class="percentage consumed">${consumedLiters !== null ? consumedLiters.toFixed(3) + ' L' : 'unknown'}</td>
        </tr>
      `;
    }).join('');
}

/**
 * Start WebRTC streaming with Roboflow
 */
async function start() {
    if (activeConnection) {
        console.warn("Already connected");
        return;
    }

    startBtn.disabled = true;
    setStatus("Connecting...");

    try {
        const connection = await connectWebcamToRoboflowWebRTC({

            onData: (data) => {
                // console.log("[Data]", data);

                const preds = data?.serialized_output_data?.predictions?.predictions || [];
                const scores = data?.serialized_output_data?.percentage || [];
                const fill = data?.serialized_output_data?.fill_level_model || [];

                // console.log("[Data]", preds, scores, fill);
                const parts = [];
                for (let i = 0; i < preds.length; i++) {
                    const trackId = preds[i]?.tracker_id;
                    const score = scores[i];
                    if (trackId != null && score != null) {
                        parts.push(`#${trackId}=${score}`);
                    }
                }

                const el = document.getElementById("levelsText");

                if (el && parts.length > 0) {
                    el.textContent = parts.join(", ");
                }

                for (let i = 0; i < scores.length; i++) {
                    const scoreItem = scores[i];
                    let bottleData = null;

                    // Handle both string (JSON) and object formats
                    if (typeof scoreItem === 'string') {
                        try {
                            bottleData = JSON.parse(scoreItem);
                        } catch (e) {
                            console.warn("[Data] Failed to parse score item:", scoreItem, e);
                            continue;
                        }
                    } else if (typeof scoreItem === 'object' && scoreItem !== null) {
                        bottleData = scoreItem;
                    } else {
                        continue;
                    }

                    const color = bottleData.bottle_color;
                    const currentPercentRaw = bottleData.fill_level_percent;

                    const currentPercent = typeof currentPercentRaw === 'number' ? currentPercentRaw : Number(currentPercentRaw);
                    const isValidPercent = currentPercent != null && !isNaN(currentPercent);

                    if (color != null) {
                        if (!bottlesByColor.has(color)) {
                            // new bottle!
                            bottlesByColor.set(color, {
                                percentHistory: isValidPercent ? [currentPercent] : [],
                                initialPercent: isValidPercent ? currentPercent : null,
                                maxAvgPercent: null,
                                capacity: BOTTLE_CAPACITY_LITERS
                            });
                        } else {
                            // Bottle exists! we update history
                            const bottle = bottlesByColor.get(color);

                            if (isValidPercent) {
                                // Valid reading: add to history
                                bottle.percentHistory.push(currentPercent);

                                if (bottle.percentHistory.length > HISTORY_SIZE) {
                                    bottle.percentHistory.shift();
                                }

                                // Calculate average when we have at least 10 values (with outlier filtering)
                                // Filter out any non-numeric values for safety
                                const validHistory = bottle.percentHistory.filter(v => typeof v === 'number' && !isNaN(v));
                                if (validHistory.length >= HISTORY_SIZE) {
                                    const filteredResult = calculateFilteredAverage(validHistory);
                                    const avgPercent = filteredResult.average;
                                    if (avgPercent !== null && (bottle.maxAvgPercent === null || avgPercent > bottle.maxAvgPercent)) {
                                        bottle.maxAvgPercent = avgPercent;
                                    }
                                }

                                const maxPercent = Math.max(...bottle.percentHistory);
                                if (maxPercent > bottle.initialPercent) {
                                    bottle.initialPercent = maxPercent; // Bottle was refilled
                                }
                            } else {
                                // This prevents bad values from staying forever... removing them each time.
                                if (bottle.percentHistory.length > 0) {
                                    bottle.percentHistory.shift();
                                }

                                const validHistory = bottle.percentHistory.filter(v => typeof v === 'number' && !isNaN(v));
                                if (validHistory.length >= HISTORY_SIZE) {
                                    const avgPercent = validHistory.reduce((a, b) => a + b, 0) / validHistory.length;
                                    if (bottle.maxAvgPercent === null || avgPercent > bottle.maxAvgPercent) {
                                        bottle.maxAvgPercent = avgPercent;
                                    }
                                } else if (validHistory.length < HISTORY_SIZE) {
                                    bottle.maxAvgPercent = null;
                                }
                            }
                        }
                    }
                }
                updateBottleTable();

                dataMessageCount++;
                dataCountEl.textContent = dataMessageCount;
                dataPreviewEl.textContent = JSON.stringify(data, null, 2);
            }


        });


        activeConnection = connection;
        const remoteStream = await connection.remoteStream();
        videoEl.srcObject = remoteStream;
        videoEl.controls = false;

        try {
            await videoEl.play();
            console.log("[UI] Video playing");
        } catch (err) {
            console.warn("[UI] Autoplay failed:", err);
        }

        setStatus("Connected - Processing video");
        stopBtn.disabled = false;

        console.log("[UI] Successfully connected!");

    } catch (err) {
        console.error("[UI] Connection failed:", err);
        if (err.message.includes('API key')) {
            setStatus("Error: Server API key not configured");
            alert("Server configuration error. Please check that ROBOFLOW_API_KEY is set in the .env file.");
        } else {
            setStatus(`Error: ${err.message}`);
        }

        startBtn.disabled = false;
        activeConnection = null;
    }
}

/**
 * Stop video processing and cleanup
 */
async function stop() {
    if (!activeConnection) {
        return;
    }

    stopBtn.disabled = true;
    setStatus("Stopping...");

    try {
        await activeConnection.cleanup();
        console.log("[UI] Cleanup complete");
    } catch (err) {
        console.error("[UI] Cleanup error:", err);
    } finally {
        activeConnection = null;
        videoEl.srcObject = null;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus("Idle");
        dataMessageCount = 0;
        dataCountEl.textContent = "0";
        dataPreviewEl.textContent = "";
        bottlesByColor.clear();
        updateBottleTable();
    }
}

// Attach event listeners
startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

// Tab switching
tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        switchTab(btn.dataset.tab);
    });
});

// Camera selection change handler
cameraInputs.cameraSelect.addEventListener("change", async (e) => {
    const deviceId = e.target.value;
    if (deviceId) {
        await getCameraCapabilities(deviceId);
    }
});

// Initialize camera enumeration on load
enumerateCameras();

// Initialize bottle table
updateBottleTable();

// Cleanup on page unload
window.addEventListener("pagehide", () => {
    if (activeConnection) {
        activeConnection.cleanup();
    }
});

window.addEventListener("beforeunload", () => {
    if (activeConnection) {
        activeConnection.cleanup();
    }
});

// Check server health on load
fetch('/api/health')
    .then(res => res.json())
    .then(data => {
        console.log('[UI] Server health:', data);
        if (!data.apiKeyConfigured) {
            console.warn('[UI] Warning: Server API key not configured');
        }
    })
    .catch(err => {
        console.error('[UI] Failed to check server health:', err);
    });
