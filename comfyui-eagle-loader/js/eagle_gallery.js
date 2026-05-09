import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const FALLBACK_EAGLE_API_BASE = "http://127.0.0.1:8765/api";
const ROUTE_BASE = "/eagle_gallery";
const BACKEND_OK_TTL_MS = 5000;
const EAGLE_GALLERY_BATCH_SIZE = 50;
const MAX_SAFE_INDEX = Number.MAX_SAFE_INTEGER;
const DEFAULT_GALLERY_THUMB_PX = 180;
const DEFAULT_GALLERY_WIDTH_VW = 96;
const DEFAULT_GALLERY_HEIGHT_VH = 90;
let cachedFolderWidgetValues = null;
let cachedFolderWidgetValuesAt = 0;

function getWidget(node, name) {
    return node.widgets?.find(w => w.name === name);
}

function clampInt(value, min, max, fallbackValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallbackValue;
    return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function debounce(fn, waitMs) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), waitMs);
    };
}

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#039;");
}

let cachedBackendOk = null;
let cachedBackendOkAt = 0;
async function backendOk() {
    if (cachedBackendOk !== null && (Date.now() - cachedBackendOkAt) < BACKEND_OK_TTL_MS) {
        return cachedBackendOk;
    }
    try {
        const response = await api.fetchApi(`${ROUTE_BASE}/ping`);
        cachedBackendOk = response.ok;
        cachedBackendOkAt = Date.now();
        return cachedBackendOk;
    } catch (e) {
        cachedBackendOk = false;
        cachedBackendOkAt = Date.now();
        return false;
    }
}

async function fetchJsonPreferBackend(path, queryParams) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams || {})) {
        if (value === undefined || value === null || value === "") continue;
        params.set(key, String(value));
    }

    const useBackend = await backendOk();
    if (useBackend) {
        const response = await api.fetchApi(`${ROUTE_BASE}${path}?${params.toString()}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
        return payload;
    }

    const response = await fetch(`${FALLBACK_EAGLE_API_BASE}${path}?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    return payload;
}

async function getUiState(node) {
    try {
        const useBackend = await backendOk();
        if (!useBackend) return {};
        const response = await api.fetchApi(`${ROUTE_BASE}/get_ui_state?node_id=${encodeURIComponent(node.id)}`);
        if (!response.ok) return {};
        return await response.json();
    } catch (e) {
        return {};
    }
}

const saveUiState = debounce(async (node, state) => {
    try {
        const useBackend = await backendOk();
        if (!useBackend) return;
        await api.fetchApi(`${ROUTE_BASE}/set_ui_state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: String(node.id), state }),
        });
    } catch (e) {
        // ignore
    }
}, 400);

function extractFolderId(value) {
    const text = String(value || "");
    if (!text || text === "All") return "";
    const match = text.match(/\[([^\]]+)\]\s*$/);
    return match ? match[1] : text;
}

function selectedIndexValue(node) {
    return clampInt(getWidget(node, "selected_index")?.value ?? 0, 0, MAX_SAFE_INDEX, 0);
}

function indexOverflowValue(node) {
    const value = String(getWidget(node, "index_overflow")?.value || "loop").toLowerCase();
    return ["placeholder", "loop", "error"].includes(value) ? value : "loop";
}

function indexModeValue(node) {
    const value = String(getWidget(node, "index_mode")?.value || "fixed").toLowerCase();
    return ["fixed", "increment", "decrement", "random"].includes(value) ? value : "fixed";
}

function formatFolderOption(folder) {
    const id = String(folder?.id || "");
    const label = folder?.path || folder?.name || id;
    return id ? `${label} [${id}]` : label;
}

async function fetchFolderWidgetValues(force = false) {
    if (!force && cachedFolderWidgetValues && (Date.now() - cachedFolderWidgetValuesAt) < 10000) {
        return cachedFolderWidgetValues;
    }
    const data = await fetchJsonPreferBackend("/folders", {});
    const folders = Array.isArray(data?.folders) ? data.folders : [];
    cachedFolderWidgetValues = ["", ...folders.map(formatFolderOption).filter(Boolean)];
    cachedFolderWidgetValuesAt = Date.now();
    return cachedFolderWidgetValues;
}

async function refreshNodeFolderOptions(node) {
    const widget = getWidget(node, "folder_filter");
    if (!widget) return;
    try {
        const data = await fetchJsonPreferBackend("/folders", {});
        const folders = Array.isArray(data?.folders) ? data.folders : [];
        const values = ["All", ...folders.map(formatFolderOption).filter(Boolean)];
        if (values.length <= 1) return;

        const currentValue = String(widget.value || "All");
        const currentFolderId = extractFolderId(currentValue);
        widget.options = widget.options || {};
        widget.options.values = values;

        if (!currentFolderId) {
            widget.value = "All";
        } else {
            const matching = values.find(value => extractFolderId(value) === currentFolderId);
            widget.value = matching || currentValue;
        }
        widget.callback?.(widget.value);
        node.setDirtyCanvas?.(true, false);
    } catch (e) {
        // Keep the static INPUT_TYPES values when the bridge is not reachable.
    }
}

function installFolderStringPicker(node, targetWidgetName, pickerName = "Folder Picker") {
    if (node.__eagleFolderPickers?.[targetWidgetName]) return;
    const target = getWidget(node, targetWidgetName);
    if (!target || typeof node.addWidget !== "function") return;
    node.__eagleFolderPickers = node.__eagleFolderPickers || {};
    node.__eagleFolderPickers[targetWidgetName] = true;

    const applyValue = value => {
        const text = String(value || "");
        target.value = text === "" ? "" : extractFolderId(text) || text;
        target.callback?.(target.value);
        node.setDirtyCanvas?.(true, false);
    };

    const picker = node.addWidget("combo", pickerName, "", value => applyValue(value), {
        values: [""],
    });
    picker.serialize = false;

    const refreshPicker = async (force = false) => {
        try {
            const values = await fetchFolderWidgetValues(force);
            picker.options = picker.options || {};
            picker.options.values = values;
            const currentId = extractFolderId(target.value);
            picker.value = currentId
                ? (values.find(value => extractFolderId(value) === currentId) || "")
                : "";
            node.setDirtyCanvas?.(true, false);
        } catch {
            // Keep the manually editable string input as fallback.
        }
    };

    node.addWidget("button", `Refresh ${pickerName}`, null, () => refreshPicker(true));
    refreshPicker(false);
}

function selectedItemFromNode(node) {
    if (indexModeValue(node) !== "fixed") return null;
    const raw = getWidget(node, "selected_item_json")?.value || "";
    if (!raw) return null;
    try {
        const item = JSON.parse(raw);
        if (!item || typeof item !== "object") return null;
        const jsonIndex = item._eagle_selected_index;
        if (jsonIndex === undefined || Number(jsonIndex) !== selectedIndexValue(node)) return null;
        return item;
    } catch {
        return null;
    }
}

async function resolveNodePreviewItem(node) {
    const selected = selectedItemFromNode(node);
    if (selected?.id) return selected;

    const requestedIndex = selectedIndexValue(node);
    const query = {
        q: getWidget(node, "search_query")?.value || "",
        tags: getWidget(node, "tags_filter")?.value || "",
        folder: extractFolderId(getWidget(node, "folder_filter")?.value || "All"),
        min_rating: clampInt(getWidget(node, "min_rating")?.value ?? 0, 0, 5, 0),
        limit: 1,
        offset: requestedIndex,
    };
    const data = await fetchJsonPreferBackend("/search", query);
    if (Array.isArray(data?.results) && data.results.length) {
        return { ...data.results[0], _eagle_resolved_index: requestedIndex, _eagle_requested_index: requestedIndex };
    }

    const total = Number(data?.total || 0);
    if (total > 0 && requestedIndex >= total && indexOverflowValue(node) === "loop") {
        const resolvedIndex = requestedIndex % total;
        const wrapped = await fetchJsonPreferBackend("/search", { ...query, offset: resolvedIndex });
        if (Array.isArray(wrapped?.results) && wrapped.results.length) {
            return { ...wrapped.results[0], _eagle_resolved_index: resolvedIndex, _eagle_requested_index: requestedIndex };
        }
    }
    return null;
}

async function eaglePreviewUrl(itemId, cacheKey = "") {
    const params = new URLSearchParams();
    params.set("id", String(itemId));
    params.set("max_size", "512");
    params.set("no_cache", "1");
    params.set("v", `${cacheKey || ""}:${Date.now()}`);
    const useBackend = await backendOk();
    return useBackend
        ? `${ROUTE_BASE}/thumbnail_image?${params.toString()}`
        : `${FALLBACK_EAGLE_API_BASE}/thumbnail_image?${params.toString()}`;
}

function installEagleNodePreview(node) {
    if (node.__eaglePreviewInstalled || typeof node.addDOMWidget !== "function") return;
    node.__eaglePreviewInstalled = true;

    const root = document.createElement("div");
    root.style.cssText = `
        width: 100%;
        height: 220px;
        min-height: 160px;
        background: #111;
        border: 1px solid #333;
        border-radius: 8px;
        overflow: hidden;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #888;
        font-size: 12px;
    `;
    const img = document.createElement("img");
    img.alt = "";
    img.style.cssText = "max-width:100%; max-height:100%; width:100%; height:100%; object-fit:contain; display:none;";
    const label = document.createElement("div");
    label.textContent = "No preview";
    label.style.cssText = "position:absolute; inset:auto 8px 8px 8px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#bbb; background:rgba(0,0,0,0.55); padding:4px 6px; border-radius:5px;";
    root.appendChild(img);
    root.appendChild(label);

    const previewWidget = node.addDOMWidget("preview", "EaglePreview", root, {
        serialize: false,
        hideOnZoom: false,
    });
    previewWidget.computeSize = () => [220, 240];
    node.setSize?.([Math.max(node.size?.[0] || 320, 340), Math.max(node.size?.[1] || 420, 520)]);

    let requestToken = 0;
    const updatePreview = debounce(async () => {
        const token = ++requestToken;
        try {
            label.textContent = "Loading preview...";
            const item = await resolveNodePreviewItem(node);
            if (token !== requestToken) return;
            if (!item?.id) {
                img.style.display = "none";
                label.textContent = "No result";
                return;
            }
            img.src = await eaglePreviewUrl(item.id, item.modifiedAt || item.thumbnailPath || "");
            img.style.display = "block";
            const resolvedIndex = Number.isFinite(Number(item._eagle_resolved_index))
                ? Number(item._eagle_resolved_index)
                : selectedIndexValue(node);
            const requestedIndex = Number.isFinite(Number(item._eagle_requested_index))
                ? Number(item._eagle_requested_index)
                : resolvedIndex;
            const prefix = requestedIndex === resolvedIndex
                ? `${resolvedIndex + 1}`
                : `${requestedIndex + 1} -> ${resolvedIndex + 1}`;
            label.textContent = `${prefix}: ${item.name || item.id}`;
        } catch (e) {
            if (token !== requestToken) return;
            img.style.display = "none";
            label.textContent = `Preview failed: ${e?.message || e}`;
        }
    }, 150);

    node.__updateEaglePreview = updatePreview;
    const watchedWidgets = ["search_query", "tags_filter", "folder_filter", "min_rating", "selected_index", "selected_item_json", "index_overflow", "index_mode"];
    for (const name of watchedWidgets) {
        const widget = getWidget(node, name);
        if (!widget || widget.__eaglePreviewPatched) continue;
        widget.__eaglePreviewPatched = true;
        const oldCallback = widget.callback;
        widget.callback = function (...args) {
            const result = oldCallback?.apply(this, args);
            updatePreview();
            return result;
        };
    }
    setTimeout(updatePreview, 100);
}

app.registerExtension({
    name: "Comfy.EagleGallery",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "EagleImageBrowser" && nodeData.name !== "Eagle Image Browser") return;
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);

            const uiPayload = message?.ui ?? message;
            if (!uiPayload || typeof uiPayload !== "object") return;

            for (const key of ["selected_index", "selected_item_json"]) {
                if (!Object.prototype.hasOwnProperty.call(uiPayload, key)) continue;
                const widget = getWidget(this, key);
                const values = uiPayload[key];
                if (!widget || !Array.isArray(values)) continue;
                widget.value = values[0];
                widget.callback?.(widget.value);
            }

            this.__updateEaglePreview?.();
            this.setDirtyCanvas?.(true, false);
        };
    },
    async nodeCreated(node) {
        if (node.comfyClass === "EagleBuildSendInfo" || node.comfyClass === "EagleBuildSendInfoSimple" || node.comfyClass === "EagleSendToEagle" || node.comfyClass === "EagleQuickSendToEagle") {
            installFolderStringPicker(node, "eagle_folder", "Eagle Folder");
            return;
        }
        if (node.comfyClass === "EagleUpdateItem" || node.comfyClass === "EagleQuickUpdateItem") {
            installFolderStringPicker(node, "folder", "Target Folder");
            return;
        }
        if (node.comfyClass === "EagleRandomImage") {
            refreshNodeFolderOptions(node).catch(() => {});
            return;
        }
        if (node.comfyClass !== "EagleImageBrowser") return;

        const selectedJsonWidget = getWidget(node, "selected_item_json");
        if (selectedJsonWidget) selectedJsonWidget.hidden = true;
        installEagleNodePreview(node);
        refreshNodeFolderOptions(node).then(() => {
            node.__updateEaglePreview?.();
        }).catch(() => {});

        node.addWidget("button", "Open Gallery", null, () => {
            showEagleGallery(node);
        });
    }
});

async function showEagleGallery(node) {
    const uiState = await getUiState(node);

    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.75);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        background: #151515;
        border: 1px solid #3a3a3a;
        border-radius: 10px;
        width: min(1600px, var(--eagle-modal-width, 96vw));
        height: var(--eagle-modal-height, 90vh);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    `;

    const header = document.createElement("div");
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        background: #1c1c1c;
        border-bottom: 1px solid #2c2c2c;
    `;
    header.innerHTML = `
        <div style="display:flex; gap:10px; align-items:baseline;">
            <div style="color:#fff; font-size:16px; font-weight:600;">Eagle Library Browser</div>
            <div style="color:#9a9a9a; font-size:12px;" id="eagle-status">Loading…</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; min-width:0; flex-wrap:wrap; justify-content:flex-end;">
            <div style="display:grid; grid-template-columns:auto 72px auto 72px; gap:6px; align-items:center; color:#aaa; font-size:11px; margin-right:4px;">
                <label for="eagle-modal-width">W</label>
                <input id="eagle-modal-width" type="range" min="60" max="100" step="2" title="Browser width" style="width:72px;" />
                <label for="eagle-modal-height">H</label>
                <input id="eagle-modal-height" type="range" min="55" max="96" step="2" title="Browser height" style="width:72px;" />
            </div>
            <button id="eagle-live" disabled title="Notify-only live updates (SSE)" style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:8px 10px; border-radius:6px; cursor:not-allowed; opacity:0.55;">Live: Off</button>
            <button id="eagle-refresh" title="Refresh gallery" style="background:#243850; border:1px solid #3b6388; color:#fff; padding:8px 10px; border-radius:6px; cursor:pointer;">Refresh</button>
            <button id="eagle-view-image" disabled title="View original image" style="background:#203040; border:1px solid #335a7a; color:#fff; padding:8px 10px; border-radius:6px; cursor:not-allowed; opacity:0.55;">View</button>
            <button id="eagle-open" disabled style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:8px 10px; border-radius:6px; cursor:not-allowed; opacity:0.55;">Open in Eagle</button>
            <button id="eagle-load-workflow" disabled title="Load embedded ComfyUI workflow from image" style="background:#203a2a; border:1px solid #2f6a4b; color:#fff; padding:8px 10px; border-radius:6px; cursor:not-allowed; opacity:0.55;">Load WF</button>
            <button id="eagle-clear" style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:8px 10px; border-radius:6px; cursor:pointer;">Clear</button>
            <button id="eagle-close" style="background:#444; border:1px solid #555; color:#fff; padding:8px 12px; border-radius:6px; cursor:pointer;">Close</button>
        </div>
    `;

    const controls = document.createElement("div");
    controls.style.cssText = `
        display: grid;
        grid-template-columns: minmax(160px, 1.8fr) minmax(140px, 1.2fr) minmax(140px, 1.2fr) minmax(90px, 0.6fr) minmax(110px, 0.8fr) minmax(130px, 0.7fr);
        gap: 10px;
        padding: 12px 16px;
        background: #161616;
        border-bottom: 1px solid #2c2c2c;
        align-items: center;
    `;
    controls.innerHTML = `
        <input id="eagle-q" placeholder="Search…" style="width:100%; padding:10px; background:#222; border:1px solid #3a3a3a; border-radius:6px; color:#fff; font-size:13px;" />
        <input id="eagle-tags" placeholder="Tags (comma-separated)..." style="width:100%; padding:10px; background:#222; border:1px solid #3a3a3a; border-radius:6px; color:#fff; font-size:13px;" />
        <select id="eagle-folder" style="width:100%; padding:10px; background:#222; border:1px solid #3a3a3a; border-radius:6px; color:#fff; font-size:13px;"></select>
        <select id="eagle-min-rating" style="width:100%; padding:10px; background:#222; border:1px solid #3a3a3a; border-radius:6px; color:#fff; font-size:13px;">
            <option value="0">★ 0+</option>
            <option value="1">★ 1+</option>
            <option value="2">★ 2+</option>
            <option value="3">★ 3+</option>
            <option value="4">★ 4+</option>
            <option value="5">★ 5</option>
        </select>
        <select id="eagle-sort" style="width:100%; padding:10px; background:#222; border:1px solid #3a3a3a; border-radius:6px; color:#fff; font-size:13px;">
            <option value="default">Default</option>
            <option value="star_desc">Star ↓</option>
            <option value="name_asc">Name A→Z</option>
            <option value="name_desc">Name Z→A</option>
            <option value="size_desc">Size ↓</option>
        </select>
        <div style="display:grid; grid-template-columns:auto minmax(70px,1fr); gap:6px; align-items:center; color:#aaa; font-size:11px;">
            <label for="eagle-thumb-size">Thumb</label>
            <input id="eagle-thumb-size" type="range" min="96" max="320" step="8" title="Thumbnail size" style="width:100%;" />
        </div>
    `;

    const gridWrap = document.createElement("div");
    gridWrap.style.cssText = `
        flex: 1;
        min-height: 0;
        overflow: auto;
        background: #0b0b0b;
        padding: 14px 16px;
    `;

    const grid = document.createElement("div");
    grid.style.cssText = `
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--eagle-thumb-size, 180px), 1fr));
        gap: 12px;
        align-content: start;
    `;
    gridWrap.appendChild(grid);

    const content = document.createElement("div");
    content.style.cssText = `
        flex: 1;
        min-height: 0;
        display: flex;
        overflow: hidden;
    `;
    const detailsPanel = document.createElement("aside");
    detailsPanel.style.cssText = `
        width: 300px;
        flex: 0 0 300px;
        overflow: auto;
        background: #101010;
        border-left: 1px solid #2c2c2c;
        color: #ddd;
        padding: 14px;
        font-size: 12px;
    `;
    content.appendChild(gridWrap);
    content.appendChild(detailsPanel);

    const footer = document.createElement("div");
    footer.style.cssText = `
        display:flex;
        justify-content: space-between;
        align-items:center;
        padding: 10px 16px;
        background: #161616;
        border-top: 1px solid #2c2c2c;
        color: #aaa;
        font-size: 12px;
    `;
    footer.innerHTML = `
        <div id="eagle-page-info">—</div>
    `;

    modal.appendChild(header);
    modal.appendChild(controls);
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const statusEl = header.querySelector("#eagle-status");
    const liveBtn = header.querySelector("#eagle-live");
    const refreshBtn = header.querySelector("#eagle-refresh");
    const viewImageBtn = header.querySelector("#eagle-view-image");
    const openBtn = header.querySelector("#eagle-open");
    const loadWorkflowBtn = header.querySelector("#eagle-load-workflow");
    const qEl = controls.querySelector("#eagle-q");
    const tagsEl = controls.querySelector("#eagle-tags");
    const folderEl = controls.querySelector("#eagle-folder");
    const minRatingEl = controls.querySelector("#eagle-min-rating");
    const sortEl = controls.querySelector("#eagle-sort");
    const thumbSizeEl = controls.querySelector("#eagle-thumb-size");
    const modalWidthEl = header.querySelector("#eagle-modal-width");
    const modalHeightEl = header.querySelector("#eagle-modal-height");
    const pageInfoEl = footer.querySelector("#eagle-page-info");

    const selectedJsonWidget = getWidget(node, "selected_item_json");
    const selectedIndexWidget = getWidget(node, "selected_index");
    const searchWidget = getWidget(node, "search_query");
    const tagsWidget = getWidget(node, "tags_filter");
    const minRatingWidget = getWidget(node, "min_rating");

    let total = 0;
    let abortController = null;
    const THUMB_MAX_SIZE = 256;
    const MAX_RENDERED_ITEMS = 500;
    const DISCARD_BATCH_SIZE = 100;
    let selectedItemId = null;
    let liveEnabled = !!uiState.live_notify;
    let eventSource = null;
    let hasPendingRefresh = false;
    let liveLibraryPath = null;
    let folderOptions = [];
    let nextOffset = 0;
    let loadedCount = 0;
    let isLoadingMore = false;
    let hasMoreResults = true;
    let searchRunId = 0;
    let thumbObserver = null;
    let loadMoreObserver = null;
    let viewerObjectUrl = null;
    let activeViewer = null;
    let activeViewerKeydownHandler = null;
    let viewerLoading = false;
    const renderedItemsById = new Map();
    const loadMoreSentinel = document.createElement("div");
    loadMoreSentinel.style.cssText = `
        grid-column: 1 / -1;
        min-height: 1px;
    `;

    const refreshBanner = document.createElement("div");
    refreshBanner.style.cssText = `
        display:none;
        margin: 0 0 10px 0;
        padding: 10px 12px;
        border-radius: 8px;
        background: #202b3a;
        border: 1px solid #2b4f78;
        color: #d6e7ff;
        font-size: 12px;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
    `;
    refreshBanner.innerHTML = `
        <div id="eagle-refresh-text">Library changed.</div>
        <div style="display:flex; gap:8px; align-items:center;">
            <button id="eagle-refresh-now" style="background:#2b4f78; border:1px solid #3b6aa0; color:#fff; padding:6px 10px; border-radius:6px; cursor:pointer;">Refresh</button>
            <button id="eagle-refresh-hide" style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:6px 10px; border-radius:6px; cursor:pointer;">Hide</button>
        </div>
    `;
    gridWrap.insertBefore(refreshBanner, gridWrap.firstChild);
    updateDetailsPanel(null);

    function close() {
        try { if (eventSource) eventSource.close(); } catch {}
        try { if (thumbObserver) thumbObserver.disconnect(); } catch {}
        try { if (loadMoreObserver) loadMoreObserver.disconnect(); } catch {}
        revokeThumbnailObjectUrls();
        revokeViewerObjectUrl();
        closeActiveViewer();
        eventSource = null;
        thumbObserver = null;
        loadMoreObserver = null;
        document.removeEventListener("keydown", onKeyDown);
        document.body.removeChild(overlay);
    }

    function onKeyDown(e) {
        if (isTextEditingTarget(e.target)) return;
        if (e.key === "Escape") close();
        if ((e.key === "o" || e.key === "O") && selectedItemId) {
            openInEagle(selectedItemId).catch(() => {});
        }
        if ((e.key === "v" || e.key === "V") && selectedItemId) {
            viewOriginalImage().catch(() => {});
        }
        if ((e.key === "l" || e.key === "L") && liveBtn && !liveBtn.disabled) {
            toggleLive().catch(() => {});
        }
        if ((e.key === "w" || e.key === "W") && selectedItemId) {
            loadWorkflowFromSelected().catch(() => {});
        }
        if ((e.key === "m" || e.key === "M") && selectedItemId) {
            detailsPanel.querySelector("#eagle-details-folder")?.focus();
        }
        if ((e.key === "Delete" || e.key === "Backspace") && selectedItemId) {
            moveToTrash().catch(() => {});
        }
    }

    function isTextEditingTarget(target) {
        if (!target) return false;
        const el = target instanceof Element ? target : null;
        if (!el) return false;
        if (el.closest?.("[contenteditable='true']")) return true;
        const tag = el.tagName;
        if (tag === "TEXTAREA" || tag === "SELECT") return true;
        if (tag !== "INPUT") return false;
        const type = String(el.getAttribute("type") || "text").toLowerCase();
        return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "image", "color"].includes(type);
    }

    function getSelectedItemFromWidget() {
        try {
            if (!selectedJsonWidget?.value) return null;
            return JSON.parse(selectedJsonWidget.value);
        } catch (e) {
            return null;
        }
    }

    function setButtonEnabled(btn, enabled) {
        if (!btn) return;
        btn.disabled = !enabled;
        btn.style.cursor = enabled ? "pointer" : "not-allowed";
        btn.style.opacity = enabled ? "1" : "0.55";
    }

    function formatBytes(value) {
        const bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes <= 0) return "-";
        const units = ["B", "KB", "MB", "GB"];
        let size = bytes;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit += 1;
        }
        return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function formatDateTime(value) {
        if (!value) return "-";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
    }

    function detailRow(label, value) {
        return `
            <div style="display:grid; grid-template-columns:82px minmax(0,1fr); gap:8px; padding:6px 0; border-bottom:1px solid #222;">
                <div style="color:#888;">${escapeHtml(label)}</div>
                <div style="color:#ddd; min-width:0; overflow-wrap:anywhere;">${escapeHtml(value ?? "-")}</div>
            </div>
        `;
    }

    function updateDetailsPanel(item) {
        if (!detailsPanel) return;
        if (!item) {
            detailsPanel.innerHTML = `
                <div style="color:#fff; font-size:14px; font-weight:600; margin-bottom:10px;">Selection</div>
                <div style="color:#888; line-height:1.5;">Select an image to inspect its metadata.</div>
            `;
            return;
        }

        const tags = Array.isArray(item.tags) ? item.tags : [];
        const tagHtml = tags.length
            ? tags.map(tag => `
                <span style="display:inline-flex; max-width:100%; align-items:center; gap:5px; margin:0 5px 5px 0; padding:3px 6px 3px 8px; border-radius:999px; background:#202a35; border:1px solid #314256; color:#cfe4ff;">
                    <span style="overflow-wrap:anywhere;">${escapeHtml(tag)}</span>
                    <button data-eagle-remove-tag="${escapeHtml(tag)}" title="Remove tag" style="width:18px; height:18px; padding:0; border-radius:999px; background:#27384b; border:1px solid #405a75; color:#e8f3ff; cursor:pointer; line-height:16px;">x</button>
                </span>
            `).join("")
            : `<span style="color:#777;">No tags</span>`;
        const annotation = String(item.annotation || "").trim();
        const dimensions = item.width || item.height ? `${item.width ?? "-"} x ${item.height ?? "-"}` : "-";
        const currentStar = clampInt(item.star ?? 0, 0, 5, 0);
        const starButtons = [0, 1, 2, 3, 4, 5].map(value => `
            <button data-eagle-star-value="${value}" style="width:32px; height:30px; background:${value === currentStar ? "#365b2e" : "#202020"}; border:1px solid ${value === currentStar ? "#5f984d" : "#383838"}; color:#eee; border-radius:6px; cursor:pointer;">${value}</button>
        `).join("");
        const currentFolders = Array.isArray(item.folders) ? item.folders.map(v => String(v)) : [];
        const currentFolderText = currentFolders.length
            ? currentFolders.map(fid => {
                const folder = folderOptions.find(f => String(f.id) === fid);
                return folder?.path || folder?.name || fid;
            }).join(", ")
            : "No folder";
        const folderOptionsHtml = [
            `<option value="">No folder</option>`,
            ...folderOptions.map(folder => {
                const id = String(folder.id || "");
                const label = folder.path || folder.name || id;
                return `<option value="${escapeHtml(id)}" ${currentFolders.includes(id) ? "selected" : ""}>${escapeHtml(label)}</option>`;
            })
        ].join("");
        detailsPanel.innerHTML = `
            <div style="color:#fff; font-size:14px; font-weight:600; margin-bottom:10px; overflow-wrap:anywhere;">${escapeHtml(item.name || item.id || "Selected image")}</div>
            ${detailRow("ID", item.id)}
            ${detailRow("Type", item.ext || "-")}
            ${detailRow("Size", formatBytes(item.size))}
            ${detailRow("Dimensions", dimensions)}
            ${detailRow("Modified", formatDateTime(item.modifiedAt))}
            <div style="padding-top:10px;">
                <div style="color:#888; margin-bottom:6px;">Star</div>
                <div style="display:flex; gap:5px; flex-wrap:wrap;">${starButtons}</div>
            </div>
            <div style="padding-top:10px;">
                <div style="color:#888; margin-bottom:6px;">Tags</div>
                <div style="line-height:1.6;">${tagHtml}</div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <input id="eagle-details-add-tag" placeholder="Add tag" style="box-sizing:border-box; min-width:0; flex:1; padding:8px; background:#1d1d1d; border:1px solid #333; color:#eee; border-radius:6px; font-size:12px;" />
                    <button id="eagle-details-add-tag-btn" style="background:#2a2a2a; border:1px solid #444; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Add</button>
                </div>
                <textarea id="eagle-details-tags" title="Edit all tags as comma-separated text" style="box-sizing:border-box; width:100%; min-height:54px; margin-top:8px; padding:8px; resize:vertical; background:#1d1d1d; border:1px solid #333; color:#eee; border-radius:6px; font-size:12px; line-height:1.4;">${escapeHtml(tags.join(", "))}</textarea>
                <button id="eagle-details-save-tags" style="margin-top:7px; background:#2a2a2a; border:1px solid #444; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Replace Tags</button>
            </div>
            <div style="padding-top:12px;">
                <div style="color:#888; margin-bottom:6px;">Annotation</div>
                <textarea id="eagle-details-annotation" style="box-sizing:border-box; width:100%; min-height:110px; padding:8px; resize:vertical; background:#1d1d1d; border:1px solid #333; color:#eee; border-radius:6px; font-size:12px; line-height:1.5;">${escapeHtml(annotation)}</textarea>
                <button id="eagle-details-save-annotation" style="margin-top:7px; background:#2a2a2a; border:1px solid #444; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Save Note</button>
            </div>
            <div style="padding-top:12px;">
                <div style="color:#888; margin-bottom:6px;">Folder</div>
                <div style="color:#bbb; font-size:11px; margin-bottom:7px; overflow-wrap:anywhere;">${escapeHtml(currentFolderText)}</div>
                <select id="eagle-details-folder" style="box-sizing:border-box; width:100%; padding:8px; background:#1d1d1d; border:1px solid #333; color:#eee; border-radius:6px; font-size:12px;">${folderOptionsHtml}</select>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <button id="eagle-details-move-folder" style="flex:1; background:#2a2a2a; border:1px solid #444; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Move</button>
                    <button id="eagle-details-clear-folder" style="background:#2a2a2a; border:1px solid #444; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Clear</button>
                </div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <input id="eagle-details-new-folder" placeholder="New folder path, e.g. A/B/C" style="box-sizing:border-box; min-width:0; flex:1; padding:8px; background:#1d1d1d; border:1px solid #333; color:#eee; border-radius:6px; font-size:12px;" />
                    <button id="eagle-details-create-folder" title="Create folder and move selected image" style="background:#203a2a; border:1px solid #2f6a4b; color:#fff; padding:7px 10px; border-radius:6px; cursor:pointer;">Create</button>
                </div>
                <button id="eagle-details-delete-folder" style="margin-top:8px; background:#3a1b1b; border:1px solid #6a2b2b; color:#fff; padding:7px 10px; border-radius:6px; cursor:pointer; width:100%;">Delete Selected Folder</button>
            </div>
            <div style="padding-top:12px;">
                <div style="color:#888; margin-bottom:6px;">Danger</div>
                <button id="eagle-details-trash" style="width:100%; background:#4a1f1f; border:1px solid #8a3636; color:#fff; padding:8px 10px; border-radius:6px; cursor:pointer;">Move to Trash...</button>
            </div>
        `;

        detailsPanel.querySelectorAll("[data-eagle-star-value]").forEach(btn => {
            btn.addEventListener("click", () => {
                const star = clampInt(btn.getAttribute("data-eagle-star-value"), 0, 5, 0);
                statusEl.textContent = "Updating star...";
                updateItem({ star }).then(() => {
                    statusEl.textContent = "Updated";
                }).catch(e => {
                    statusEl.textContent = `Update failed: ${e?.message || e}`;
                });
            });
        });
        detailsPanel.querySelectorAll("[data-eagle-remove-tag]").forEach(btn => {
            btn.addEventListener("click", () => {
                const tag = btn.getAttribute("data-eagle-remove-tag") || "";
                if (!tag) return;
                statusEl.textContent = "Removing tag...";
                updateItem({ tags_remove: tag }).then(() => {
                    statusEl.textContent = "Updated";
                }).catch(e => {
                    statusEl.textContent = `Update failed: ${e?.message || e}`;
                });
            });
        });
        const addTag = () => {
            const input = detailsPanel.querySelector("#eagle-details-add-tag");
            const value = input?.value ?? "";
            if (!String(value).trim()) return;
            statusEl.textContent = "Adding tag...";
            updateItem({ tags_add: value }).then(() => {
                statusEl.textContent = "Updated";
            }).catch(e => {
                statusEl.textContent = `Update failed: ${e?.message || e}`;
            });
        };
        detailsPanel.querySelector("#eagle-details-add-tag-btn")?.addEventListener("click", addTag);
        detailsPanel.querySelector("#eagle-details-add-tag")?.addEventListener("keydown", e => {
            if (e.key === "Enter") {
                e.preventDefault();
                addTag();
            }
        });
        detailsPanel.querySelector("#eagle-details-save-tags")?.addEventListener("click", () => {
            const value = detailsPanel.querySelector("#eagle-details-tags")?.value ?? "";
            statusEl.textContent = "Updating tags...";
            updateItem({ tags_set: value }).then(() => {
                statusEl.textContent = "Updated";
            }).catch(e => {
                statusEl.textContent = `Update failed: ${e?.message || e}`;
            });
        });
        detailsPanel.querySelector("#eagle-details-save-annotation")?.addEventListener("click", () => {
            const value = detailsPanel.querySelector("#eagle-details-annotation")?.value ?? "";
            statusEl.textContent = "Updating note...";
            updateItem({ annotation_set: value }).then(() => {
                statusEl.textContent = "Updated";
            }).catch(e => {
                statusEl.textContent = `Update failed: ${e?.message || e}`;
            });
        });
        detailsPanel.querySelector("#eagle-details-move-folder")?.addEventListener("click", () => {
            const value = detailsPanel.querySelector("#eagle-details-folder")?.value ?? "";
            moveFolder(value).catch(e => {
                statusEl.textContent = `Move failed: ${e?.message || e}`;
            });
        });
        detailsPanel.querySelector("#eagle-details-clear-folder")?.addEventListener("click", () => {
            moveFolder("").catch(e => {
                statusEl.textContent = `Move failed: ${e?.message || e}`;
            });
        });
        const createFolderAndMove = () => {
            const value = detailsPanel.querySelector("#eagle-details-new-folder")?.value ?? "";
            if (!String(value).trim()) return;
            moveFolder(value, { refreshFolders: true }).catch(e => {
                statusEl.textContent = `Create folder failed: ${e?.message || e}`;
            });
        };
        detailsPanel.querySelector("#eagle-details-create-folder")?.addEventListener("click", createFolderAndMove);
        detailsPanel.querySelector("#eagle-details-new-folder")?.addEventListener("keydown", e => {
            if (e.key === "Enter") {
                e.preventDefault();
                createFolderAndMove();
            }
        });
        detailsPanel.querySelector("#eagle-details-delete-folder")?.addEventListener("click", () => {
            const folderId = detailsPanel.querySelector("#eagle-details-folder")?.value ?? "";
            deleteFolder(folderId).catch(e => {
                statusEl.textContent = `Delete folder failed: ${e?.message || e}`;
            });
        });
        detailsPanel.querySelector("#eagle-details-trash")?.addEventListener("click", () => {
            moveToTrash().catch(e => {
                statusEl.textContent = `Trash failed: ${e?.message || e}`;
            });
        });
    }

    function refreshActionButtonLabels() {
        const item = getSelectedItemFromWidget();
        updateDetailsPanel(item);
    }

    function setActionButtonsEnabled(enabled) {
        setButtonEnabled(viewImageBtn, enabled);
        setButtonEnabled(openBtn, enabled);
        setButtonEnabled(loadWorkflowBtn, enabled);
        if (enabled) refreshActionButtonLabels();
    }

    function setLiveButtonEnabled(enabled) {
        setButtonEnabled(liveBtn, enabled);
        if (!liveBtn) return;
        liveBtn.textContent = liveEnabled ? "Live: On" : "Live: Off";
    }

    function setPendingRefresh(message) {
        hasPendingRefresh = true;
        const textEl = refreshBanner.querySelector("#eagle-refresh-text");
        if (textEl && message) textEl.textContent = message;
        refreshBanner.style.display = "flex";
    }

    function clearPendingRefresh() {
        hasPendingRefresh = false;
        refreshBanner.style.display = "none";
    }

    async function toggleLive() {
        const useBackend = await backendOk();
        if (!useBackend) return;

        liveEnabled = !liveEnabled;
        if (liveBtn) liveBtn.textContent = liveEnabled ? "Live: On" : "Live: Off";
        saveUiState(node, {
            q: qEl.value ?? "",
            tags: tagsEl.value ?? "",
            folder_id: folderEl.value ?? "All",
            min_rating: clampInt(minRatingEl.value, 0, 5, 0),
            sort: sortEl.value ?? "default",
            live_notify: liveEnabled,
        });

        if (!liveEnabled) {
            try { if (eventSource) eventSource.close(); } catch {}
            eventSource = null;
            statusEl.textContent = "Live updates off";
            return;
        }

        statusEl.textContent = "Connecting live updates…";
        try { if (eventSource) eventSource.close(); } catch {}
        eventSource = new EventSource(`${ROUTE_BASE}/events`);

        eventSource.addEventListener("open", () => {
            if (!liveEnabled) return;
            statusEl.textContent = "Live updates connected";
        });

        eventSource.addEventListener("error", () => {
            if (!liveEnabled) return;
            statusEl.textContent = "Live updates disconnected";
        });

        eventSource.addEventListener("bridge_error", (ev) => {
            if (!liveEnabled) return;
            try {
                const data = JSON.parse(ev.data || "{}");
                statusEl.textContent = `Live updates error: ${data?.error || "Unknown error"}`;
            } catch (e) {
                statusEl.textContent = "Live updates error";
            }
        });

        eventSource.addEventListener("hello", (ev) => {
            if (!liveEnabled) return;
            try {
                const data = JSON.parse(ev.data || "{}");
                if (data.library_path !== undefined) {
                    liveLibraryPath = data.library_path || null;
                }
                if (data.live_supported === false) {
                    liveEnabled = false;
                    try { if (eventSource) eventSource.close(); } catch {}
                    eventSource = null;
                    if (liveBtn) liveBtn.textContent = "Live: Unsupported";
                    statusEl.textContent = "Live updates unsupported by this Eagle version";
                }
            } catch (e) {
                // ignore
            }
        });

        eventSource.addEventListener("live_unsupported", (ev) => {
            if (!liveEnabled) return;
            liveEnabled = false;
            try { if (eventSource) eventSource.close(); } catch {}
            eventSource = null;
            if (liveBtn) liveBtn.textContent = "Live: Unsupported";
            statusEl.textContent = "Live updates unsupported by this Eagle version";
        });

        eventSource.addEventListener("items_changed", (ev) => {
            if (!liveEnabled) return;
            try {
                const data = JSON.parse(ev.data || "{}");
                const totalChanges = Number(data.added_count || 0) + Number(data.modified_count || 0) + Number(data.removed_count || 0);
                if (totalChanges > 0) setPendingRefresh(`Library changed (${totalChanges}). Click Refresh.`);
            } catch (e) {
                setPendingRefresh("Library changed. Click Refresh.");
            }
        });

        eventSource.addEventListener("library_changed", (ev) => {
            if (!liveEnabled) return;
            try {
                const data = JSON.parse(ev.data || "{}");
                const nextLibraryPath = data.library_path || null;
                if (nextLibraryPath && liveLibraryPath && nextLibraryPath === liveLibraryPath) {
                    return;
                }
                liveLibraryPath = nextLibraryPath;
            } catch (e) {
                // If the payload is malformed, keep the old conservative behavior.
            }
            setPendingRefresh("Library switched. Click Refresh.");
        });
    }

    async function postJsonPreferBackend(path, body) {
        const useBackend = await backendOk();
        const requestBody = JSON.stringify(body || {});
        if (useBackend) {
            const response = await api.fetchApi(`${ROUTE_BASE}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
            return payload;
        }

        const response = await fetch(`${FALLBACK_EAGLE_API_BASE}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
        return payload;
    }

    async function openInEagle(itemId) {
        if (!itemId) return;
        try {
            await postJsonPreferBackend("/open", { id: String(itemId) });
            statusEl.textContent = `Opened in Eagle: ${String(itemId)}`;
        } catch (e) {
            statusEl.textContent = `Open failed: ${e?.message || e}`;
        }
    }

    function revokeViewerObjectUrl() {
        if (!viewerObjectUrl) return;
        try { URL.revokeObjectURL(viewerObjectUrl); } catch {}
        viewerObjectUrl = null;
    }

    function closeActiveViewer() {
        if (activeViewerKeydownHandler) {
            document.removeEventListener("keydown", activeViewerKeydownHandler);
            activeViewerKeydownHandler = null;
        }
        if (activeViewer) {
            try { activeViewer.remove(); } catch {}
            activeViewer = null;
        }
        viewerLoading = false;
        revokeViewerObjectUrl();
    }

    async function fetchOriginalImageBlob(itemId) {
        const params = new URLSearchParams();
        params.set("id", String(itemId));
        params.set("no_cache", "1");
        const useBackend = await backendOk();
        const response = useBackend
            ? await api.fetchApi(`${ROUTE_BASE}/image?${params.toString()}`)
            : await fetch(`${FALLBACK_EAGLE_API_BASE}/image?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.blob();
    }

    async function viewOriginalImage() {
        if (!selectedItemId) return;
        if (viewerLoading) return;
        closeActiveViewer();
        viewerLoading = true;
        const getCardForId = (itemId) => grid.querySelector(`[data-eagle-id="${CSS.escape(String(itemId))}"]`);
        const getItemForId = (itemId) => renderedItemsById.get(String(itemId)) || getSelectedItemFromWidget() || { id: String(itemId) };
        const getAdjacentItemId = (direction) => {
            const card = getCardForId(selectedItemId);
            if (!card) return null;
            let next = direction < 0 ? card.previousElementSibling : card.nextElementSibling;
            while (next && !next.hasAttribute("data-eagle-id")) {
                next = direction < 0 ? next.previousElementSibling : next.nextElementSibling;
            }
            return next?.getAttribute("data-eagle-id") || null;
        };

        statusEl.textContent = "Loading image…";
        const initialId = String(selectedItemId);
        const initialItem = getItemForId(initialId);
        let blob = null;
        try {
            blob = await fetchOriginalImageBlob(initialId);
        } catch (e) {
            viewerLoading = false;
            throw e;
        }
        viewerObjectUrl = URL.createObjectURL(blob);

        const viewer = document.createElement("div");
        viewer.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 10002;
            background: rgba(0, 0, 0, 0.88);
            display: flex;
            flex-direction: column;
        `;
        viewer.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; background:#121212; border-bottom:1px solid #333;">
                <div id="eagle-view-title" style="min-width:0; color:#eee; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(initialItem?.name || initialId)}</div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <button id="eagle-view-prev" style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Prev</button>
                    <button id="eagle-view-next" style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Next</button>
                    <button id="eagle-view-open-tab" style="background:#2a2a2a; border:1px solid #3a3a3a; color:#eee; padding:7px 10px; border-radius:6px; cursor:pointer;">Open Tab</button>
                    <button id="eagle-view-close" style="background:#444; border:1px solid #555; color:#fff; padding:7px 10px; border-radius:6px; cursor:pointer;">Close</button>
                </div>
            </div>
            <div style="flex:1; min-height:0; overflow:auto; display:flex; align-items:center; justify-content:center; padding:18px;">
                <img id="eagle-view-img" src="${viewerObjectUrl}" alt="" style="max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 8px 28px rgba(0,0,0,0.55);" />
            </div>
        `;
        const titleEl = viewer.querySelector("#eagle-view-title");
        const imageEl = viewer.querySelector("#eagle-view-img");
        const prevBtn = viewer.querySelector("#eagle-view-prev");
        const nextBtn = viewer.querySelector("#eagle-view-next");
        const setViewerButtonsEnabled = (loading = false) => {
            const hasPrev = !!getAdjacentItemId(-1);
            const hasNext = !!getAdjacentItemId(1);
            setButtonEnabled(prevBtn, hasPrev && !loading);
            setButtonEnabled(nextBtn, hasNext && !loading);
        };
        const showItemInViewer = async (itemId) => {
            if (!itemId || itemId === selectedItemId) return;
            const item = getItemForId(itemId);
            const card = getCardForId(itemId);
            const absoluteIndex = Number(card?.getAttribute("data-eagle-index") ?? 0) || 0;
            setViewerButtonsEnabled(true);
            statusEl.textContent = "Loading image…";
            const nextBlob = await fetchOriginalImageBlob(itemId);
            revokeViewerObjectUrl();
            viewerObjectUrl = URL.createObjectURL(nextBlob);
            imageEl.src = viewerObjectUrl;
            titleEl.textContent = item?.name || itemId;
            setSelection(item, absoluteIndex);
            card?.scrollIntoView({ block: "nearest", inline: "nearest" });
            setViewerButtonsEnabled(false);
            statusEl.textContent = "Image loaded";
        };
        const closeViewer = () => {
            closeActiveViewer();
        };
        const onViewerKeyDown = (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                closeViewer();
            } else if (e.key === "ArrowLeft") {
                e.stopPropagation();
                showItemInViewer(getAdjacentItemId(-1)).catch(err => {
                    statusEl.textContent = `View failed: ${err?.message || err}`;
                    setViewerButtonsEnabled(false);
                });
            } else if (e.key === "ArrowRight") {
                e.stopPropagation();
                showItemInViewer(getAdjacentItemId(1)).catch(err => {
                    statusEl.textContent = `View failed: ${err?.message || err}`;
                    setViewerButtonsEnabled(false);
                });
            }
        };
        viewer.querySelector("#eagle-view-close").onclick = closeViewer;
        prevBtn.onclick = () => showItemInViewer(getAdjacentItemId(-1)).catch(e => {
            statusEl.textContent = `View failed: ${e?.message || e}`;
            setViewerButtonsEnabled(false);
        });
        nextBtn.onclick = () => showItemInViewer(getAdjacentItemId(1)).catch(e => {
            statusEl.textContent = `View failed: ${e?.message || e}`;
            setViewerButtonsEnabled(false);
        });
        viewer.querySelector("#eagle-view-open-tab").onclick = () => {
            if (viewerObjectUrl) window.open(viewerObjectUrl, "_blank", "noopener");
        };
        viewer.addEventListener("click", (e) => {
            if (e.target === viewer) closeViewer();
        });
        activeViewer = viewer;
        activeViewerKeydownHandler = onViewerKeyDown;
        document.addEventListener("keydown", activeViewerKeydownHandler);
        document.body.appendChild(viewer);
        viewerLoading = false;
        setViewerButtonsEnabled(false);
        statusEl.textContent = "Image loaded";
    }

    async function updateItem(patch) {
        const payload = { id: String(selectedItemId), ...(patch || {}) };
        const data = await postJsonPreferBackend("/update_item", payload);
        if (data?.item && selectedJsonWidget) {
            selectedJsonWidget.value = JSON.stringify(data.item);
            renderedItemsById.set(String(data.item.id || selectedItemId), data.item);
            updateDetailsPanel(data.item);
        } else {
            refreshActionButtonLabels();
        }
        return data;
    }

    function removeRenderedItem(itemId) {
        if (!itemId) return;
        const id = String(itemId);
        const card = grid.querySelector(`[data-eagle-id="${CSS.escape(id)}"]`);
        if (card) {
            try { if (thumbObserver) thumbObserver.unobserve(card); } catch {}
            revokeThumbnailObjectUrls(card);
            card.remove();
        }
        renderedItemsById.delete(id);
        loadedCount = Math.max(0, loadedCount - 1);
        pageInfoEl.textContent = `Loaded ${loadedCount}${total ? ` of ${total}` : ""}`;
    }

    async function moveFolder(folderValue, options = {}) {
        if (!selectedItemId) return;
        const input = folderValue ?? "";
        const movedItemId = String(selectedItemId);
        const currentFolderFilter = folderEl.value || "All";
        statusEl.textContent = "Updating folder…";
        await updateItem({ folder: input });
        if (options.refreshFolders) await loadFolders({ refreshDetails: false });
        const latestItem = getSelectedItemFromWidget();
        if (latestItem?.id) updateDetailsPanel(latestItem);
        statusEl.textContent = "Updated";
        const movedOutOfFilteredFolder = currentFolderFilter !== "All" && String(input || "") !== currentFolderFilter;
        if (movedOutOfFilteredFolder) {
            removeRenderedItem(movedItemId);
            clearSelection();
        }
    }

    async function moveToTrash() {
        if (!selectedItemId) return;
        const item = getSelectedItemSnapshot();
        const label = item?.name || selectedItemId;
        if (!confirm(`Move this item to trash?\n\n${label}`)) return;
        statusEl.textContent = "Moving to trash…";
        await updateItem({ trash: true });
        statusEl.textContent = "Trashed";
        clearSelection();
        await search();
    }

    async function deleteFolder(folderId) {
        const id = String(folderId || "").trim();
        if (!id) {
            statusEl.textContent = "Select a folder to delete";
            return;
        }
        const folder = folderOptions.find(f => String(f.id) === id);
        const label = folder?.path || folder?.name || id;
        if (!confirm(`Delete this Eagle folder?\n\n${label}\n\nImages in the folder are not moved by this action.`)) return;
        statusEl.textContent = "Deleting folder…";
        await postJsonPreferBackend("/folder_delete", { folder: id });
        await loadFolders();
        statusEl.textContent = "Folder deleted";
        await search({ preserveState: true });
    }

    async function loadWorkflowFromSelected() {
        if (!selectedItemId) return;
        statusEl.textContent = "Loading workflow…";
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.info("[EagleLoadWF] request", { rid: requestId, itemId: String(selectedItemId) });
        try {
            const useBackend = await backendOk();
            if (!useBackend) {
                statusEl.textContent = "Load WF requires ComfyUI backend proxy (token-safe)";
                return;
            }
            const nativeLoaded = await tryLoadWorkflowViaComfyFile(requestId);
            if (nativeLoaded) {
                statusEl.textContent = "Workflow loaded";
                close();
                return;
            }

            const response = await api.fetchApi(`${ROUTE_BASE}/workflow_metadata?id=${encodeURIComponent(String(selectedItemId))}&debug=1&rid=${encodeURIComponent(requestId)}`);
            const data = await response.json().catch(() => ({}));
            console.info("[EagleLoadWF] response", {
                rid: requestId,
                ok: response.ok,
                status: response.status,
                hasWorkflow: !!data?.has_workflow,
                parsedKeys: data?.parsed_keys || [],
                source: data?.source || {},
                error: data?.error || "",
            });
            if (!response.ok) throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
            if (!data?.has_workflow || !data?.workflow) {
                statusEl.textContent = "No embedded workflow found";
                return;
            }
            console.info("[EagleLoadWF] native file path unavailable; falling back to direct graph load", { rid: requestId });
            const loaded = await tryLoadWorkflowIntoComfyUI(data.workflow);
            if (loaded) {
                statusEl.textContent = "Workflow loaded";
                close();
            } else {
                statusEl.textContent = "Failed to load workflow (unsupported UI)";
            }
        } catch (e) {
            console.error("[EagleLoadWF] failed", e);
            statusEl.textContent = `Load workflow failed: ${e?.message || e}`;
        }
    }

    function getSelectedItemSnapshot() {
        try {
            const value = selectedJsonWidget?.value || "";
            return value ? JSON.parse(value) : null;
        } catch {
            return null;
        }
    }

    function selectedItemFilename() {
        const item = getSelectedItemSnapshot();
        const name = String(item?.name || selectedItemId || "eagle-workflow").replace(/[\\/:*?"<>|]/g, "_");
        const ext = String(item?.ext || "png").replace(/^\./, "").replace(/[^a-zA-Z0-9]/g, "") || "png";
        return name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name : `${name}.${ext}`;
    }

    async function tryLoadWorkflowViaComfyFile(requestId) {
        if (!app || typeof app.handleFile !== "function") return false;
        try {
            const url = `${ROUTE_BASE}/image?id=${encodeURIComponent(String(selectedItemId))}&debug=1&rid=${encodeURIComponent(requestId)}`;
            console.info("[EagleLoadWF] native file request", { rid: requestId, itemId: String(selectedItemId), url });
            const response = await api.fetchApi(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const type = blob.type || response.headers.get("Content-Type") || "image/png";
            const file = new File([blob], selectedItemFilename(), { type });
            console.info("[EagleLoadWF] native file load", { rid: requestId, name: file.name, type: file.type, bytes: file.size });
            await app.handleFile(file, "eagle");
            console.info("[EagleLoadWF] app.handleFile completed", { rid: requestId });
            return true;
        } catch (e) {
            console.error("[EagleLoadWF] native file load exception", e);
            return false;
        }
    }

    async function tryLoadWorkflowIntoComfyUI(workflow) {
        console.info("[EagleLoadWF] workflow summary", {
            hasVersion: !!workflow?.version,
            version: workflow?.version,
            nodes: Array.isArray(workflow?.nodes) ? workflow.nodes.length : null,
            links: Array.isArray(workflow?.links) ? workflow.links.length : null,
            hasExtra: !!workflow?.extra,
            keys: workflow && typeof workflow === "object" ? Object.keys(workflow) : [],
            loadGraphData: typeof app?.loadGraphData,
            loadGraph: typeof app?.loadGraph,
            graphConfigure: typeof app?.graph?.configure,
            canvasGraphConfigure: typeof app?.canvas?.graph?.configure,
        });
        try {
            // Common ComfyUI frontend APIs (varies by version)
            if (app && typeof app.loadGraphData === "function") {
                await app.loadGraphData(workflow, true, true, "Eagle Workflow", { openSource: "eagle" });
                console.info("[EagleLoadWF] loaded via app.loadGraphData");
                return true;
            }
            if (app && typeof app.loadGraph === "function") {
                await app.loadGraph(workflow);
                console.info("[EagleLoadWF] loaded via app.loadGraph");
                return true;
            }
            if (app && app.graph && typeof app.graph.configure === "function") {
                app.graph.configure(workflow);
                if (typeof app.graph.setDirtyCanvas === "function") app.graph.setDirtyCanvas(true, true);
                console.info("[EagleLoadWF] loaded via app.graph.configure");
                return true;
            }
            // Some builds expose the graph on app.canvas
            if (app && app.canvas && app.canvas.graph && typeof app.canvas.graph.configure === "function") {
                app.canvas.graph.configure(workflow);
                if (typeof app.canvas.graph.setDirtyCanvas === "function") app.canvas.graph.setDirtyCanvas(true, true);
                console.info("[EagleLoadWF] loaded via app.canvas.graph.configure");
                return true;
            }
            console.error("[EagleLoadWF] no supported graph loading API found", { app });
            return false;
        } catch (e) {
            console.error("[EagleLoadWF] graph load exception", e);
            return false;
        }
    }

    async function loadFolders(options = {}) {
        const refreshDetails = options.refreshDetails !== false;
        refreshNodeFolderOptions(node).catch(() => {});
        folderEl.innerHTML = "";
        const optAll = document.createElement("option");
        optAll.value = "All";
        optAll.textContent = "All folders";
        folderEl.appendChild(optAll);
        try {
            const data = await fetchJsonPreferBackend("/folders", {});
            const folders = data.folders || [];
            folderOptions = Array.isArray(folders) ? folders.slice() : [];
            for (const folder of folders) {
                const opt = document.createElement("option");
                opt.value = folder.id;
                const baseLabel = folder.path || folder.name || folder.id || "";
                opt.textContent = folder.id ? `${baseLabel} [${folder.id}]` : baseLabel;
                folderEl.appendChild(opt);
            }
        } catch (e) {
            folderOptions = [];
            // ignore; keep All only
        }
        if (refreshDetails) {
            const item = getSelectedItemFromWidget();
            if (item?.id) updateDetailsPanel(item);
        }
    }

    function applyInitialValues() {
        const initialQuery = (searchWidget?.value ?? uiState.q ?? "").toString();
        const initialTags = (tagsWidget?.value ?? uiState.tags ?? "").toString();
        const initialMinRating = clampInt(minRatingWidget?.value ?? uiState.min_rating ?? 0, 0, 5, 0);
        const initialSort = (uiState.sort ?? "default").toString();
        const initialFolderId = (getWidget(node, "folder_filter")?.value ?? uiState.folder_id ?? "All").toString();
        const initialThumbPx = clampInt(uiState.thumb_px ?? DEFAULT_GALLERY_THUMB_PX, 96, 320, DEFAULT_GALLERY_THUMB_PX);
        const initialWidthVw = clampInt(uiState.modal_width_vw ?? DEFAULT_GALLERY_WIDTH_VW, 60, 100, DEFAULT_GALLERY_WIDTH_VW);
        const initialHeightVh = clampInt(uiState.modal_height_vh ?? DEFAULT_GALLERY_HEIGHT_VH, 55, 96, DEFAULT_GALLERY_HEIGHT_VH);

        qEl.value = initialQuery;
        tagsEl.value = initialTags;
        minRatingEl.value = String(initialMinRating);
        sortEl.value = initialSort;
        folderEl.value = extractFolderId(initialFolderId);
        if (folderEl.value !== extractFolderId(initialFolderId)) folderEl.value = "All";
        thumbSizeEl.value = String(initialThumbPx);
        modalWidthEl.value = String(initialWidthVw);
        modalHeightEl.value = String(initialHeightVh);
        applyGallerySizing();
    }

    function gallerySizingState() {
        return {
            thumb_px: clampInt(thumbSizeEl.value, 96, 320, DEFAULT_GALLERY_THUMB_PX),
            modal_width_vw: clampInt(modalWidthEl.value, 60, 100, DEFAULT_GALLERY_WIDTH_VW),
            modal_height_vh: clampInt(modalHeightEl.value, 55, 96, DEFAULT_GALLERY_HEIGHT_VH),
        };
    }

    function applyGallerySizing() {
        const sizing = gallerySizingState();
        grid.style.setProperty("--eagle-thumb-size", `${sizing.thumb_px}px`);
        modal.style.setProperty("--eagle-modal-width", `${sizing.modal_width_vw}vw`);
        modal.style.setProperty("--eagle-modal-height", `${sizing.modal_height_vh}vh`);
    }

    const saveGallerySizing = debounce(() => {
        applyGallerySizing();
        saveUiState(node, {
            q: qEl.value ?? "",
            tags: tagsEl.value ?? "",
            folder_id: folderEl.value ?? "All",
            min_rating: clampInt(minRatingEl.value, 0, 5, 0),
            sort: sortEl.value ?? "default",
            live_notify: liveEnabled,
            ...gallerySizingState(),
        });
    }, 250);

    function syncBrowserControlsToNode() {
        if (searchWidget) searchWidget.value = qEl.value ?? "";
        if (tagsWidget) tagsWidget.value = tagsEl.value ?? "";
        if (minRatingWidget) minRatingWidget.value = clampInt(minRatingEl.value, 0, 5, 0);
        const folderWidget = getWidget(node, "folder_filter");
        if (folderWidget) {
            const folderValue = folderEl.value || "All";
            const matchingOption = folderWidget.options?.values?.find?.(value => extractFolderId(value) === folderValue);
            folderWidget.value = matchingOption || folderValue;
        }
        node.__updateEaglePreview?.();
    }

    function applySort(results, sort) {
        if (sort === "star_desc") return results.sort((a, b) => (b.star ?? 0) - (a.star ?? 0));
        if (sort === "name_asc") return results.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
        if (sort === "name_desc") return results.sort((a, b) => String(b.name ?? "").localeCompare(String(a.name ?? "")));
        if (sort === "size_desc") return results.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
        return results;
    }

    async function getThumbnailUrl(itemId, cacheKey = "", requestId = "") {
        const params = new URLSearchParams();
        params.set("id", String(itemId));
        params.set("max_size", String(THUMB_MAX_SIZE));
        params.set("no_cache", "1");
        if (requestId) params.set("rid", String(requestId));
        if (cacheKey) params.set("v", String(cacheKey));

        const useBackend = await backendOk();
        if (useBackend) return `${ROUTE_BASE}/thumbnail_image?${params.toString()}`;
        return `${FALLBACK_EAGLE_API_BASE}/thumbnail_image?${params.toString()}`;
    }

    function revokeThumbnailObjectUrl(imgEl) {
        const objectUrl = imgEl?.dataset?.objectUrl;
        if (!objectUrl) return;
        try { URL.revokeObjectURL(objectUrl); } catch {}
        delete imgEl.dataset.objectUrl;
    }

    function revokeThumbnailObjectUrls(root = grid) {
        root.querySelectorAll?.("img[data-object-url]").forEach(imgEl => {
            revokeThumbnailObjectUrl(imgEl);
        });
    }

    async function loadThumbnailIntoCard(card, itemId, cacheKey) {
        const imgEl = card.querySelector("img");
        if (!imgEl || !itemId) return;

        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const requestToken = `${itemId}:${cacheKey || ""}:${requestId}`;
        card.setAttribute("data-eagle-thumb-request", requestToken);

        const url = await getThumbnailUrl(itemId, `${cacheKey || ""}:${requestToken}`, requestId);
        const useBackend = await backendOk();
        const response = useBackend
            ? await api.fetchApi(url, { cache: "no-store" })
            : await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const responseItemId = response.headers.get("X-Eagle-Item-Id");
        if (responseItemId && responseItemId !== String(itemId)) {
            throw new Error(`Thumbnail item mismatch: ${responseItemId} != ${itemId}`);
        }

        const blob = await response.blob();
        if (!card.isConnected) return;
        if (card.getAttribute("data-eagle-id") !== String(itemId)) return;
        if (card.getAttribute("data-eagle-thumb-request") !== requestToken) return;

        const objectUrl = URL.createObjectURL(blob);
        revokeThumbnailObjectUrl(imgEl);
        imgEl.dataset.objectUrl = objectUrl;
        imgEl.src = objectUrl;
    }

    function highlightSelected(selectedId) {
        grid.querySelectorAll("[data-eagle-id]").forEach(el => {
            const isSelected = el.getAttribute("data-eagle-id") === String(selectedId);
            el.style.outline = isSelected ? "2px solid #4CAF50" : "1px solid #2c2c2c";
        });
    }

    function setSelection(item, absoluteIndex) {
        const itemForWidget = item && typeof item === "object"
            ? { ...item, _eagle_selected_index: absoluteIndex }
            : item;
        if (selectedJsonWidget) selectedJsonWidget.value = JSON.stringify(itemForWidget);
        if (selectedIndexWidget) selectedIndexWidget.value = absoluteIndex;

        selectedItemId = item?.id ? String(item.id) : null;
        setActionButtonsEnabled(!!selectedItemId);
        statusEl.textContent = `Selected: ${item.name ?? item.id ?? "(unknown)"}`;
        highlightSelected(item.id);
        updateDetailsPanel(item);
        node.__updateEaglePreview?.();
    }

    function clearSelection() {
        if (selectedJsonWidget) selectedJsonWidget.value = "";
        selectedItemId = null;
        setActionButtonsEnabled(false);
        statusEl.textContent = "Selection cleared";
        highlightSelected(null);
        updateDetailsPanel(null);
        node.__updateEaglePreview?.();
    }

    function captureGalleryState() {
        return {
            selectedId: selectedItemId,
            selectedIndex: selectedIndexValue(node),
            scrollTop: gridWrap.scrollTop,
        };
    }

    function restoreSelectedFromRendered(selectedId) {
        if (!selectedId) return false;
        const item = renderedItemsById.get(String(selectedId));
        const card = grid.querySelector(`[data-eagle-id="${CSS.escape(String(selectedId))}"]`);
        if (!item || !card) return false;
        const absoluteIndex = Number(card.getAttribute("data-eagle-index") ?? 0) || 0;
        setSelection(item, absoluteIndex);
        return true;
    }

    function restoreSelectedIndexFromRendered(index) {
        const card = grid.querySelector(`[data-eagle-index="${CSS.escape(String(index))}"]`);
        const itemId = card?.getAttribute("data-eagle-id") || "";
        if (!itemId) return false;
        const restored = restoreSelectedFromRendered(itemId);
        if (restored) card.scrollIntoView({ block: "nearest", inline: "nearest" });
        return restored;
    }

    function pageStartForIndex(index, batchSize) {
        const safeIndex = Math.max(0, Number(index) || 0);
        const safeBatch = Math.max(1, Number(batchSize) || 1);
        return Math.floor(safeIndex / safeBatch) * safeBatch;
    }

    async function resolveBrowserStartIndex(requestedIndex) {
        const safeRequested = Math.max(0, Number(requestedIndex) || 0);
        const query = {
            q: qEl.value ?? "",
            tags: tagsEl.value ?? "",
            folder: folderEl.value === "All" ? "" : (folderEl.value ?? ""),
            min_rating: clampInt(minRatingEl.value, 0, 5, 0),
            sort: sortEl.value ?? "default",
            limit: 1,
            offset: safeRequested,
        };
        const data = await fetchJsonPreferBackend("/search", query);
        const resultCount = Array.isArray(data?.results) ? data.results.length : 0;
        const resultTotal = Number(data?.total ?? 0) || 0;
        if (resultCount > 0 || resultTotal <= 0 || safeRequested < resultTotal) {
            return {
                selectedIndex: safeRequested,
                pageOffset: pageStartForIndex(safeRequested, EAGLE_GALLERY_BATCH_SIZE),
                total: resultTotal,
                overflowed: false,
            };
        }

        if (indexOverflowValue(node) === "loop") {
            const wrappedIndex = safeRequested % resultTotal;
            if (selectedIndexWidget) selectedIndexWidget.value = wrappedIndex;
            if (selectedJsonWidget) selectedJsonWidget.value = "";
            return {
                selectedIndex: wrappedIndex,
                pageOffset: pageStartForIndex(wrappedIndex, EAGLE_GALLERY_BATCH_SIZE),
                total: resultTotal,
                overflowed: true,
                message: `selected_index wrapped: ${safeRequested + 1} -> ${wrappedIndex + 1}`,
            };
        }

        const lastIndex = Math.max(0, resultTotal - 1);
        return {
            selectedIndex: null,
            pageOffset: pageStartForIndex(lastIndex, EAGLE_GALLERY_BATCH_SIZE),
            total: resultTotal,
            overflowed: true,
            message: `selected_index out of range: ${safeRequested + 1} > ${resultTotal}`,
        };
    }

    async function restoreGalleryState(state) {
        if (!state) return;
        const targetId = state.selectedId ? String(state.selectedId) : "";
        let restoredSelection = restoreSelectedFromRendered(targetId);
        if (!restoredSelection && Number.isFinite(Number(state.selectedIndex))) {
            restoredSelection = restoreSelectedIndexFromRendered(Number(state.selectedIndex));
        }
        requestAnimationFrame(() => {
            gridWrap.scrollTop = Math.max(0, Number(state.scrollTop) || 0);
            if (restoredSelection) highlightSelected(targetId);
        });
    }

    function ensureThumbObserver() {
        if (thumbObserver) return thumbObserver;
        thumbObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const card = entry.target;
                thumbObserver.unobserve(card);
                const itemId = card.getAttribute("data-eagle-id");
                const thumbVersion = card.getAttribute("data-eagle-thumb-version") || "";
                if (!itemId) continue;
                loadThumbnailIntoCard(card, itemId, thumbVersion).catch(() => {});
            }
        }, { root: gridWrap, rootMargin: "200px" });
        return thumbObserver;
    }

    function ensureLoadMoreObserver() {
        if (loadMoreObserver) return loadMoreObserver;
        loadMoreObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && hasMoreResults && !isLoadingMore) {
                    loadMore().catch(() => {});
                }
            }
        }, { root: gridWrap, rootMargin: "600px" });
        loadMoreObserver.observe(loadMoreSentinel);
        return loadMoreObserver;
    }

    function trimRenderedCards() {
        const cards = Array.from(grid.querySelectorAll("[data-eagle-id]"));
        if (cards.length <= MAX_RENDERED_ITEMS) return;

        const removeCount = Math.min(DISCARD_BATCH_SIZE, cards.length - MAX_RENDERED_ITEMS);
        for (let i = 0; i < removeCount; i++) {
            const card = cards[i];
            try { if (thumbObserver) thumbObserver.unobserve(card); } catch {}
            revokeThumbnailObjectUrls(card);
            renderedItemsById.delete(String(card.getAttribute("data-eagle-id") || ""));
            card.remove();
        }
    }

    function renderResults(results, startIndex) {
        for (let i = 0; i < results.length; i++) {
            const item = results[i];
            const absoluteIndex = startIndex + i;
            const card = document.createElement("div");
            renderedItemsById.set(String(item.id), item);
            card.setAttribute("data-eagle-id", String(item.id));
            card.setAttribute("data-eagle-index", String(absoluteIndex));
            card.setAttribute("data-eagle-thumb-version", String(item.modifiedAt ?? item.thumbnailPath ?? ""));
            card.style.cssText = `
                cursor: pointer;
                background: #141414;
                border-radius: 8px;
                overflow: hidden;
                outline: 1px solid #2c2c2c;
                transition: transform 0.08s ease, outline-color 0.08s ease;
            `;
            card.addEventListener("mouseenter", () => { card.style.transform = "translateY(-1px)"; });
            card.addEventListener("mouseleave", () => { card.style.transform = "translateY(0px)"; });
            card.addEventListener("click", () => setSelection(item, absoluteIndex));

            card.innerHTML = `
                <div style="aspect-ratio:1; background:#222; display:flex; align-items:center; justify-content:center;">
                    <img alt="" loading="lazy" decoding="async" style="width:100%; height:100%; object-fit:cover; display:block;" />
                </div>
                <div style="padding:8px 10px;">
                    <div style="color:#fff; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.name ?? "")}</div>
                    <div style="display:flex; justify-content:space-between; gap:8px; margin-top:4px; color:#9a9a9a; font-size:11px;">
                        <div>${(item.width ?? "-")}×${(item.height ?? "-")}</div>
                        <div>★ ${item.star ?? 0}</div>
                    </div>
                </div>
            `;

            grid.insertBefore(card, loadMoreSentinel);
            ensureThumbObserver().observe(card);
        }
        trimRenderedCards();

        try {
            const currentSelected = selectedJsonWidget?.value ? JSON.parse(selectedJsonWidget.value) : null;
            if (currentSelected?.id) {
                selectedItemId = String(currentSelected.id);
                setActionButtonsEnabled(true);
                highlightSelected(currentSelected.id);
                updateDetailsPanel(renderedItemsById.get(selectedItemId) || currentSelected);
            } else {
                selectedItemId = null;
                setActionButtonsEnabled(false);
                updateDetailsPanel(null);
            }
        } catch (e) {
            // ignore
        }
    }

    function resetResults() {
        if (abortController) abortController.abort();
        searchRunId += 1;
        nextOffset = 0;
        loadedCount = 0;
        total = 0;
        hasMoreResults = true;
        isLoadingMore = false;
        if (thumbObserver) {
            try { thumbObserver.disconnect(); } catch {}
            thumbObserver = null;
        }
        revokeThumbnailObjectUrls();
        renderedItemsById.clear();
        grid.innerHTML = "";
        grid.appendChild(loadMoreSentinel);
        clearSelection();
    }

    async function loadMore() {
        if (isLoadingMore || !hasMoreResults) return;
        isLoadingMore = true;

        if (abortController) abortController.abort();
        abortController = new AbortController();
        const signal = abortController.signal;
        const runId = searchRunId;
        const q = qEl.value ?? "";
        const tags = tagsEl.value ?? "";
        const folderId = folderEl.value ?? "All";
        const minRating = clampInt(minRatingEl.value, 0, 5, 0);
        const limit = EAGLE_GALLERY_BATCH_SIZE;
        const offset = nextOffset;
        const sort = sortEl.value ?? "default";

        statusEl.textContent = offset === 0 ? "Searching..." : "Loading more...";

        saveUiState(node, {
            q,
            tags,
            folder_id: folderId,
            min_rating: minRating,
            sort,
            live_notify: liveEnabled,
            ...gallerySizingState(),
        });
        syncBrowserControlsToNode();

        try {
            if (signal.aborted) return;
            const data = await fetchJsonPreferBackend("/search", {
                q,
                tags,
                folder: folderId === "All" ? "" : folderId,
                min_rating: minRating,
                sort,
                limit,
                offset,
            });
            if (signal.aborted || runId !== searchRunId) return;

            total = Number(data.total ?? 0) || 0;
            let results = (data.results || []).slice();

            if (minRating > 0) results = results.filter(r => (r.star ?? 0) >= minRating);
            results = applySort(results, sort);

            const receivedCount = Array.isArray(data.results) ? data.results.length : 0;
            nextOffset += receivedCount;
            loadedCount += results.length;
            hasMoreResults = receivedCount >= limit && (!total || nextOffset < total);

            if (offset === 0 && !results.length) {
                grid.innerHTML = `<div style="color:#888; padding:24px;">No results</div>`;
                grid.appendChild(loadMoreSentinel);
            } else {
                renderResults(results, offset);
            }

            statusEl.textContent = `Showing ${loadedCount}${total ? ` / ${total}` : ""}`;
            pageInfoEl.textContent = hasMoreResults
                ? `Loaded ${loadedCount}${total ? ` of ${total}` : ""} • Batch ${limit}`
                : `End • Loaded ${loadedCount}${total ? ` of ${total}` : ""}`;
            if (!loadedCount && !hasMoreResults) {
                grid.innerHTML = `<div style="color:#888; padding:24px;">No results</div>`;
                grid.appendChild(loadMoreSentinel);
            }
            if (hasPendingRefresh) clearPendingRefresh();
        } catch (e) {
            if (signal.aborted) return;
            statusEl.textContent = "Error";
            pageInfoEl.textContent = "—";
            grid.innerHTML = `
                <div style="color:#f66; padding:24px;">
                    <div style="font-size:14px; margin-bottom:6px;">Connection error</div>
                    <div style="font-size:12px; color:#caa;">${escapeHtml(String(e.message || e))}</div>
                </div>
            `;
            grid.appendChild(loadMoreSentinel);
        } finally {
            if (!signal.aborted && runId === searchRunId) {
                isLoadingMore = false;
            }
        }
    }

    async function search(options = {}) {
        const preserveState = !!options.preserveState;
        const previousState = preserveState ? captureGalleryState() : null;
        let start = null;
        if (preserveState && previousState && Number.isFinite(Number(previousState.selectedIndex))) {
            try {
                start = await resolveBrowserStartIndex(Number(previousState.selectedIndex));
            } catch {
                start = null;
            }
        }
        resetResults();
        ensureLoadMoreObserver();
        if (start) {
            nextOffset = Math.max(0, Number(start.pageOffset) || 0);
            if (Number.isFinite(Number(start.selectedIndex))) {
                previousState.selectedIndex = Number(start.selectedIndex);
            }
            if (start.overflowed) previousState.selectedId = "";
        } else if (preserveState && previousState?.selectedIndex) {
            nextOffset = pageStartForIndex(previousState.selectedIndex, EAGLE_GALLERY_BATCH_SIZE);
        }
        await loadMore();
        if (start?.message) statusEl.textContent = start.message;
        if (preserveState) await restoreGalleryState(previousState);
    }

    async function searchAndRestoreNodeSelection() {
        const item = selectedItemFromNode(node);
        const index = selectedIndexValue(node);
        const state = {
            selectedId: item?.id || "",
            scrollTop: 0,
        };
        let start = {
            selectedIndex: index,
            pageOffset: pageStartForIndex(index, EAGLE_GALLERY_BATCH_SIZE),
            overflowed: false,
        };
        try {
            start = await resolveBrowserStartIndex(index);
        } catch (e) {
            statusEl.textContent = `Index check failed: ${e?.message || e}`;
        }
        resetResults();
        ensureLoadMoreObserver();
        nextOffset = Math.max(0, Number(start.pageOffset) || 0);
        await loadMore();
        if (start.message) statusEl.textContent = start.message;
        if (state.selectedId) {
            await restoreGalleryState(state);
            return;
        }
        if (Number.isFinite(Number(start.selectedIndex))) {
            restoreSelectedIndexFromRendered(Number(start.selectedIndex));
        }
    }

    header.querySelector("#eagle-close").onclick = close;
    header.querySelector("#eagle-clear").onclick = clearSelection;
    if (liveBtn) liveBtn.onclick = () => toggleLive();
    if (refreshBtn) refreshBtn.onclick = () => search({ preserveState: true });
    if (viewImageBtn) viewImageBtn.onclick = () => selectedItemId && viewOriginalImage().catch(e => {
        statusEl.textContent = `View failed: ${e?.message || e}`;
    });
    if (openBtn) openBtn.onclick = () => selectedItemId && openInEagle(selectedItemId);
    if (loadWorkflowBtn) loadWorkflowBtn.onclick = () => selectedItemId && loadWorkflowFromSelected();
    setActionButtonsEnabled(false);
    setLiveButtonEnabled(false);

    refreshBanner.querySelector("#eagle-refresh-now").onclick = () => search({ preserveState: true });
    refreshBanner.querySelector("#eagle-refresh-hide").onclick = () => clearPendingRefresh();

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKeyDown);

    const triggerSearch = debounce(() => {
        syncBrowserControlsToNode();
        search();
    }, 250);
    qEl.addEventListener("input", triggerSearch);
    tagsEl.addEventListener("input", triggerSearch);
    folderEl.addEventListener("change", triggerSearch);
    minRatingEl.addEventListener("change", triggerSearch);
    sortEl.addEventListener("change", triggerSearch);
    thumbSizeEl.addEventListener("input", saveGallerySizing);
    modalWidthEl.addEventListener("input", saveGallerySizing);
    modalHeightEl.addEventListener("input", saveGallerySizing);

    await loadFolders();
    applyInitialValues();

    if (header.querySelector("#eagle-close")) header.querySelector("#eagle-close").focus();
    backendOk().then((ok) => {
        setLiveButtonEnabled(ok);
        if (ok && liveEnabled) toggleLive().catch(() => {});
    }).catch(() => setLiveButtonEnabled(false));
    await searchAndRestoreNodeSelection();
}
