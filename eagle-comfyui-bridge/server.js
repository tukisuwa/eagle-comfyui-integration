const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

let server = null;
let requestCount = 0;

// Small in-memory cache for resized images/thumbnails (bytes)
const RESIZED_CACHE_MAX_ENTRIES = 128;
const RESIZED_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64MB
let resizedCacheBytes = 0;
const resizedCache = new Map(); // key -> { buffer, mimeType, etag, bytes }
let cachedNativeImage = undefined; // undefined = not resolved yet; null = unavailable
let eagleItemReadQueue = Promise.resolve();

// SSE (Server-Sent Events) for notify-only live updates
const sseClients = new Set(); // Set<http.ServerResponse>
let sseHeartbeatTimer = null;
let ssePollTimer = null;
let ssePollInFlight = false;
let lastKnownIdsWithModifiedAt = new Map(); // id -> modifiedAt
let lastKnownLibraryPath = null;
const SSE_POLL_INTERVAL_MS = 2500;
const SSE_HEARTBEAT_MS = 20000;
const SSE_MAX_IDS_PER_EVENT = 200;

// UI要素
let statusElement, portElement, countElement, logElement;
let bindElement, tokenElement;

let bindHost = "127.0.0.1";
let bridgeToken = "";

function supportsSseItemChangePolling() {
    return !!(eagle && eagle.item && typeof eagle.item.getIdsWithModifiedAt === 'function');
}

function getCurrentLibraryPath() {
    return (eagle && eagle.library && eagle.library.path) || null;
}

function runEagleItemReadLocked(fn) {
    const run = eagleItemReadQueue.then(fn, fn);
    eagleItemReadQueue = run.catch(() => {});
    return run;
}

function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function getItemByIdStrict(itemId, debugLabel = "") {
    const expectedId = String(itemId);
    let lastItem = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
        const item = await runEagleItemReadLocked(() => eagle.item.getById(expectedId));
        lastItem = item || null;
        if (item && String(item.id || "") === expectedId) return item;

        await new Promise(resolve => setTimeout(resolve, 25 * attempt));
    }

    return lastItem;
}

function pathBelongsToItemInfo(value, itemId) {
    if (!value) return false;
    const normalized = String(value).replace(/\\/g, '/').toLowerCase();
    return normalized.includes(`/${String(itemId).toLowerCase()}.info/`);
}

async function getItemByIdWithOwnedMediaPath(itemId, debugLabel = "") {
    let lastItem = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        const item = await getItemByIdStrict(itemId, `${debugLabel} media attempt=${attempt}`);
        lastItem = item || null;
        if (!item || String(item.id || "") !== String(itemId)) return item;
        if (pathBelongsToItemInfo(item.thumbnailPath, itemId) || pathBelongsToItemInfo(item.filePath, itemId)) {
            return item;
        }
        await new Promise(resolve => setTimeout(resolve, 40 * attempt));
    }
    return lastItem;
}

async function getItemByIdWithOwnedFilePath(itemId, debugLabel = "") {
    let lastItem = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        const item = await getItemByIdStrict(itemId, `${debugLabel} file attempt=${attempt}`);
        lastItem = item || null;
        if (!item || String(item.id || "") !== String(itemId)) return item;
        if (pathBelongsToItemInfo(item.filePath, itemId)) return item;
        await new Promise(resolve => setTimeout(resolve, 40 * attempt));
    }
    return lastItem;
}

function parsePort(value, fallbackPort) {
    const port = parseInt(value, 10);
    if (!Number.isFinite(port) || port < 1024 || port > 65535) return fallbackPort;
    return port;
}

eagle.onPluginCreate(async (plugin) => {
    console.log('Eagle-ComfyUI Bridge starting...');
    
    // UI要素の取得
    statusElement = document.getElementById('server-status');
    portElement = document.getElementById('server-port');
    countElement = document.getElementById('request-count');
    logElement = document.getElementById('activity-log');
    bindElement = document.getElementById('bind-input');
    tokenElement = document.getElementById('token-input');
    
    // デフォルトポートでサーバー起動
    const defaultPort = 8765;
    bindHost = bindElement?.value || "127.0.0.1";
    bridgeToken = tokenElement?.value || "";
    startServer(defaultPort, bindHost);

    // Ensure we stop the server when the plugin is closing
    eagle.onPluginBeforeExit(() => {
        try {
            for (const client of Array.from(sseClients)) {
                try { client.end(); } catch {}
            }
            sseClients.clear();
            ensureSseStoppedIfIdle();
            if (server) {
                server.close(() => addLog('Server stopped', 'success'));
                server = null;
            }
        } catch (e) {
            // Best-effort cleanup
        }
    });
    
    // Notify SSE clients when the library switches (and reset polling baseline)
    eagle.onLibraryChanged((libraryPath) => {
        const nextLibraryPath = libraryPath || getCurrentLibraryPath();
        if (!lastKnownLibraryPath) {
            lastKnownLibraryPath = nextLibraryPath || null;
            return;
        }
        if ((nextLibraryPath || null) === lastKnownLibraryPath) {
            return;
        }

        lastKnownLibraryPath = nextLibraryPath || null;
        lastKnownIdsWithModifiedAt = new Map();
        broadcastSse('library_changed', { library_path: lastKnownLibraryPath, ts: Date.now() });
    });

    // 再起動ボタン
    document.getElementById('restart-btn').addEventListener('click', () => {
        const portInput = document.getElementById('port-input');
        const port = parsePort(portInput?.value, defaultPort);
        if (portInput) portInput.value = port;

        bindHost = bindElement?.value || "127.0.0.1";
        bridgeToken = tokenElement?.value || "";

        if (bindHost !== "127.0.0.1" && !bridgeToken) {
            addLog("Refusing to bind to 0.0.0.0 without a token", "error");
            updateStatus("Error", "-");
            return;
        }

        if (server) {
            server.close(() => {
                addLog('Server stopped', 'success');
                startServer(port, bindHost);
            });
        } else {
            startServer(port, bindHost);
        }
    });
});

function startServer(port, host = "127.0.0.1") {
    if (host !== "127.0.0.1" && !bridgeToken) {
        addLog("Refusing to start: bind is not localhost and token is empty", "error");
        updateStatus("Error", "-");
        return;
    }
    server = http.createServer(async (req, res) => {
        requestCount++;
        updateRequestCount();
        
        // CORS対応
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Eagle-Bridge-Token');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        
        addLog(`${req.method} ${pathname}`);
        
        try {
            // ルーティング
            if (pathname === '/api/search') {
                await handleSearch(req, res, parsedUrl.query);
            } else if (pathname === '/api/thumbnail') {
                await handleThumbnail(req, res, parsedUrl.query);
            } else if (pathname === '/api/thumbnail_image') {
                await handleGetThumbnailFile(req, res, parsedUrl.query);
            } else if (pathname === '/api/get_image') {
                await handleGetImage(req, res, parsedUrl.query);
            } else if (pathname === '/api/folders') {
                await handleGetFolders(req, res);
            } else if (pathname === '/api/tags') {
                await handleGetTags(req, res);
            } else if (pathname === '/api/stats') {
                await handleGetStats(req, res);
            } else if (pathname === '/api/add_from_url' && req.method === 'POST') {
                await handleAddFromUrl(req, res, parsedUrl.query);
            } else if (pathname === '/api/add_from_base64' && req.method === 'POST') {
                await handleAddFromBase64(req, res, parsedUrl.query);
            } else if (pathname === '/api/open' && req.method === 'POST') {
                await handleOpenItem(req, res, parsedUrl.query);
            } else if (pathname === '/api/update_item' && req.method === 'POST') {
                await handleUpdateItem(req, res, parsedUrl.query);
            } else if (pathname === '/api/folder_delete' && req.method === 'POST') {
                await handleDeleteFolder(req, res, parsedUrl.query);
            } else if (pathname === '/api/events') {
                await handleSseEvents(req, res, parsedUrl.query);
            } else if (pathname === '/api/image') {
                await handleGetImageFile(req, res, parsedUrl.query);
            } else if (pathname === '/') {
                // ステータスチェック用
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    status: 'ok', 
                    version: '1.0.0',
                    requests: requestCount 
                }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Endpoint not found' }));
            }
        } catch (error) {
            addLog(`Error: ${error.message}`, 'error');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    
    server.listen(port, host, () => {
        addLog(`Bridge server started on http://${host}:${port}`, 'success');
        updateStatus('Running', port);
    });
    
    server.on('error', (error) => {
        addLog(`Server error: ${error.message}`, 'error');
        updateStatus('Error', '-');
    });
}

// 検索API
async function handleSearch(req, res, query) {
    const searchQuery = query.q || '';
    const tags = query.tags ? query.tags.split(',').map(t => t.trim()).filter(t => t) : [];
    const folder = query.folder || null;
    const annotation = query.annotation || '';
    const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 50, 1000));
    const offset = Math.max(0, parseInt(query.offset, 10) || 0);
    const sort = String(query.sort || 'default');
    const minRating = Math.max(0, Math.min(parseInt(query.min_rating, 10) || 0, 5));
    
    const options = {};
    
    if (searchQuery) {
        const keywords = String(searchQuery).split(/\s+/).map(k => k.trim()).filter(k => k);
        if (keywords.length > 0) {
            options.keywords = keywords;
        }
    }
    
    if (tags.length > 0) {
        options.tags = tags;
    }
    
    if (folder) {
        options.folders = [folder];
    }

    if (annotation) {
        options.annotation = String(annotation);
    }

    // Only return the fields we actually expose to the client (performance)
    options.fields = [
        'id',
        'name',
        'ext',
        'width',
        'height',
        'tags',
        'annotation',
        'filePath',
        'thumbnailPath',
        'size',
        'star',
        'folders',
        'modifiedAt'
    ];
    
    let items = await eagle.item.get(options);
    if (minRating > 0) {
        items = items.filter(item => (Number(item.star) || 0) >= minRating);
    }
    items = sortItems(items, sort);
    const results = items.slice(offset, offset + limit).map(item => ({
        id: item.id,
        name: item.name,
        ext: item.ext,
        width: item.width,
        height: item.height,
        tags: item.tags,
        annotation: item.annotation,
        filePath: item.filePath,
        thumbnailPath: item.thumbnailPath,
        size: item.size,
        star: item.star,
        folders: item.folders,
        modifiedAt: item.modifiedAt
    }));
    
    addLog(`Search: "${searchQuery}" -> ${results.length}/${items.length} results`, 'success');
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        results, 
        count: results.length,
        total: items.length 
    }));
}

function sortItems(items, sort) {
    const sorted = Array.isArray(items) ? items.slice() : [];
    const numberValue = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    const textValue = (value) => String(value || '');

    if (sort === 'star_desc') {
        sorted.sort((a, b) => numberValue(b.star) - numberValue(a.star));
    } else if (sort === 'name_asc') {
        sorted.sort((a, b) => textValue(a.name).localeCompare(textValue(b.name)));
    } else if (sort === 'name_desc') {
        sorted.sort((a, b) => textValue(b.name).localeCompare(textValue(a.name)));
    } else if (sort === 'size_desc') {
        sorted.sort((a, b) => numberValue(b.size) - numberValue(a.size));
    }
    return sorted;
}

// サムネイル取得API（Base64）
function getAuthTokenFromRequest(req, query) {
    const auth = req.headers['authorization'] || '';
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    const headerToken = req.headers['x-eagle-bridge-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
        return headerToken.trim();
    }
    if (query && typeof query.token === 'string' && query.token.trim()) {
        return query.token.trim();
    }
    return '';
}

function requireAuth(req, res, query) {
    if (!bridgeToken) return true;
    const token = getAuthTokenFromRequest(req, query);
    if (token !== bridgeToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
    }
    return true;
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

async function getAllFoldersFlat() {
    const rawFolders = await eagle.folder.getAll();
    const folders = Array.isArray(rawFolders)
        ? rawFolders
        : (Array.isArray(rawFolders?.folders)
            ? rawFolders.folders
            : (Array.isArray(rawFolders?.data) ? rawFolders.data : []));
    const flat = [];
    const seen = new Set();

    function folderIdOf(folder) {
        return folder?.id ?? folder?.folderId ?? folder?.folder_id ?? folder?.uuid ?? folder?._id ?? "";
    }

    function folderNameOf(folder) {
        return folder?.name ?? folder?.folderName ?? folder?.folder_name ?? folder?.title ?? folder?.label ?? "";
    }

    function folderParentOf(folder) {
        return folder?.parent ?? folder?.parentId ?? folder?.parent_id ?? folder?.pid ?? "";
    }

    function visit(folder, parentId = null, depth = 0) {
        const rawId = folderIdOf(folder);
        if (!folder || rawId === undefined || rawId === null || rawId === "") return;
        const id = String(rawId);
        if (seen.has(id)) return;
        seen.add(id);

        const rawParent = folderParentOf(folder);
        const normalized = {
            ...folder,
            id,
            name: String(folderNameOf(folder) || id),
            parent: rawParent === undefined || rawParent === null || rawParent === "" ? "" : String(rawParent),
        };
        if (!normalized.parent && parentId) {
            normalized.parent = String(parentId);
        }
        normalized.depth = depth;
        flat.push(normalized);

        const children = Array.isArray(folder.children)
            ? folder.children
            : (Array.isArray(folder.folders) ? folder.folders : []);
        for (const child of children) {
            visit(child, id, depth + 1);
        }
    }

    for (const folder of folders || []) {
        const parent = folderParentOf(folder);
        visit(folder, parent || null, Number.isFinite(Number(folder?.depth)) ? Number(folder.depth) : 0);
    }

    return flat;
}

function folderParentMatches(folder, parentId) {
    const folderParent = folder?.parent === undefined || folder?.parent === null || folder?.parent === ""
        ? null
        : String(folder.parent);
    const expectedParent = parentId === undefined || parentId === null || parentId === ""
        ? null
        : String(parentId);
    return folderParent === expectedParent;
}

async function resolveFolderId(folderValue) {
    if (!folderValue) return "";
    const folderIdOrPath = String(folderValue).trim();
    if (!folderIdOrPath) return "";

    // 1) Treat as explicit ID if it exists
    try {
        const byId = await eagle.folder.getById(folderIdOrPath);
        if (byId && byId.id) {
            return byId.id;
        }
    } catch (e) {
        // ignore
    }

    try {
        const byIds = await eagle.folder.get({ ids: [folderIdOrPath] });
        if (Array.isArray(byIds) && byIds.length > 0 && byIds[0]?.id) {
            return byIds[0].id;
        }
    } catch (e) {
        // ignore
    }

    // 2) Treat as folder path: A/B/C (also supports A\\B\\C and A > B > C)
    const parts = folderIdOrPath
        .split(/[\\/＞>]/g)
        .map(p => p.trim())
        .filter(p => p);

    if (parts.length === 0) return "";

    let parentId = null;
    const allFolders = await getAllFoldersFlat();
    for (const name of parts) {
        const existing = (allFolders || []).find(f => f && f.name === name && folderParentMatches(f, parentId));
        if (existing && existing.id) {
            parentId = existing.id;
            continue;
        }

        const created = await eagle.folder.create(parentId ? { name, parent: parentId } : { name });
        if (created?.id) {
            allFolders.push({ ...created, name: created.name || name, parent: parentId });
            parentId = created.id;
        }
    }

    return parentId || "";
}

async function resolveExistingFolderId(folderValue) {
    if (!folderValue) return "";
    const folderIdOrPath = String(folderValue).trim();
    if (!folderIdOrPath) return "";

    try {
        const byId = await eagle.folder.getById(folderIdOrPath);
        if (byId && byId.id) return byId.id;
    } catch (e) {
        // ignore
    }

    try {
        const byIds = await eagle.folder.get({ ids: [folderIdOrPath] });
        if (Array.isArray(byIds) && byIds.length > 0 && byIds[0]?.id) return byIds[0].id;
    } catch (e) {
        // ignore
    }

    const parts = folderIdOrPath
        .split(/[\\/＞>]/g)
        .map(p => p.trim())
        .filter(p => p);
    if (parts.length === 0) return "";

    let parentId = null;
    const allFolders = await getAllFoldersFlat();
    for (const name of parts) {
        const existing = (allFolders || []).find(f => f && f.name === name && folderParentMatches(f, parentId));
        if (!existing || !existing.id) return "";
        parentId = existing.id;
    }
    return parentId || "";
}

async function handleAddFromUrl(req, res, query) {
    if (!requireAuth(req, res, query)) return;

    const body = await readJsonBody(req, 512 * 1024);
    const imageUrl = body.url;
    if (!imageUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing url' }));
        return;
    }

    const name = body.name || '';
    const website = body.website || '';
    const annotation = body.annotation || '';
    const tags = Array.isArray(body.tags) ? body.tags : (body.tags ? String(body.tags).split(',').map(t => t.trim()).filter(t => t) : []);
    const folderValue = body.folder || body.folderId || '';

    const folderId = await resolveFolderId(folderValue);

    const options = {};
    if (name) options.name = name;
    if (website) options.website = website;
    if (annotation) options.annotation = annotation;
    if (tags.length) options.tags = tags;
    if (folderId) options.folders = [folderId];

    addLog(`[Add from URL] start name="${name || ''}" folder="${folderValue || ''}" tags=${tags.length}`, 'info');
    const itemId = await withTimeout(
        eagle.item.addFromURL(imageUrl, options),
        120000,
        'eagle.item.addFromURL'
    );
    addLog(`[Add from URL] done itemId=${itemId || ''} name="${name || ''}"`, 'success');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, itemId }));
}

async function handleAddFromBase64(req, res, query) {
    if (!requireAuth(req, res, query)) return;

    const body = await readJsonBody(req, 128 * 1024 * 1024);
    let base64 = body.base64 || '';
    if (!base64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing base64' }));
        return;
    }

    // Accept data URL format
    const prefixIndex = String(base64).indexOf('base64,');
    if (prefixIndex !== -1) {
        base64 = String(base64).slice(prefixIndex + 7);
    }

    const name = body.name || '';
    const website = body.website || '';
    const annotation = body.annotation || '';
    const tags = Array.isArray(body.tags) ? body.tags : (body.tags ? String(body.tags).split(',').map(t => t.trim()).filter(t => t) : []);
    const folderValue = body.folder || body.folderId || '';

    const folderId = await resolveFolderId(folderValue);

    const options = {};
    if (name) options.name = name;
    if (website) options.website = website;
    if (annotation) options.annotation = annotation;
    if (tags.length) options.tags = tags;
    if (folderId) options.folders = [folderId];

    const approxBytes = Math.floor(String(base64).length * 3 / 4);
    addLog(`[Add from Base64] start name="${name || ''}" folder="${folderValue || ''}" tags=${tags.length} approx_bytes=${approxBytes}`, 'info');
    const itemId = await withTimeout(
        eagle.item.addFromBase64(base64, options),
        120000,
        'eagle.item.addFromBase64'
    );
    addLog(`[Add from Base64] done itemId=${itemId || ''} name="${name || ''}"`, 'success');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, itemId }));
}

async function handleOpenItem(req, res, query) {
    if (!requireAuth(req, res, query)) return;

    let itemId = query.id || '';
    if (!itemId) {
        try {
            const body = await readJsonBody(req, 64 * 1024);
            itemId = body.id || body.itemId || '';
        } catch (e) {
            // ignore
        }
    }

    if (!itemId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing item ID' }));
        return;
    }

    await eagle.item.open(String(itemId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: String(itemId) }));
}

function _parseTagsFlexible(value) {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
        const out = [];
        for (const t of value) {
            if (typeof t !== 'string') continue;
            const s = t.trim();
            if (s) out.push(s);
        }
        return out;
    }
    const str = String(value);
    return str.split(',').map(t => t.trim()).filter(t => t);
}

function _uniqueTagsPreserveOrder(tags) {
    const seen = new Set();
    const out = [];
    for (const t of (tags || [])) {
        const s = String(t || '').trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

function _pickItemForClient(item) {
    if (!item) return null;
    return {
        id: item.id,
        name: item.name,
        ext: item.ext,
        width: item.width,
        height: item.height,
        tags: item.tags,
        annotation: item.annotation,
        filePath: item.filePath,
        thumbnailPath: item.thumbnailPath,
        size: item.size,
        star: item.star,
        folders: item.folders,
        isDeleted: item.isDeleted,
        modifiedAt: item.modifiedAt,
        url: item.url,
    };
}

async function handleUpdateItem(req, res, query) {
    if (!requireAuth(req, res, query)) return;

    let body = {};
    try {
        body = await readJsonBody(req, 256 * 1024);
    } catch (e) {
        body = {};
    }

    const itemId = body.id || body.itemId || query.id;
    if (!itemId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing item ID' }));
        return;
    }

    const item = await eagle.item.getById(String(itemId));
    if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Item not found' }));
        return;
    }

    // Move to trash (side-effect)
    if (body.trash === true || body.moveToTrash === true) {
        await item.moveToTrash();
        const updatedAfterTrash = await eagle.item.getById(String(itemId));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, item: _pickItemForClient(updatedAfterTrash || item) }));
        return;
    }

    // Star rating
    if (body.toggle_star === true || body.toggleStar === true) {
        item.star = (Number(item.star || 0) > 0) ? 0 : 5;
    } else if (body.star !== undefined && body.star !== null && body.star !== '') {
        const star = parsePositiveInt(body.star, null, 0, 5);
        if (star !== null) item.star = star;
    }

    // Tags
    const tagsSet = _parseTagsFlexible(body.tags_set ?? body.tagsSet);
    const tagsAdd = _parseTagsFlexible(body.tags_add ?? body.tagsAdd);
    const tagsRemove = _parseTagsFlexible(body.tags_remove ?? body.tagsRemove);
    if (tagsSet !== null) {
        item.tags = _uniqueTagsPreserveOrder(tagsSet);
    } else if (tagsAdd !== null || tagsRemove !== null) {
        const current = Array.isArray(item.tags) ? item.tags.slice() : [];
        let next = current;
        if (tagsRemove && tagsRemove.length) {
            const removeSet = new Set(tagsRemove.map(t => String(t).toLowerCase()));
            next = next.filter(t => !removeSet.has(String(t).toLowerCase()));
        }
        if (tagsAdd && tagsAdd.length) {
            next = next.concat(tagsAdd);
        }
        item.tags = _uniqueTagsPreserveOrder(next);
    }

    // Annotation
    if (body.annotation_set !== undefined && body.annotation_set !== null) {
        item.annotation = String(body.annotation_set);
    } else if (body.annotationSet !== undefined && body.annotationSet !== null) {
        item.annotation = String(body.annotationSet);
    }
    const appendValue = (body.annotation_append !== undefined && body.annotation_append !== null) ? body.annotation_append : body.annotationAppend;
    if (appendValue !== undefined && appendValue !== null) {
        const appendText = String(appendValue);
        if (appendText.trim()) {
            const existing = (typeof item.annotation === 'string') ? item.annotation : '';
            item.annotation = existing ? (existing + '\n' + appendText) : appendText;
        }
    }

    // Folder move (accept folder id or path)
    if (body.folder !== undefined || body.folderId !== undefined || body.folder_id !== undefined) {
        const folderValue = (body.folder ?? body.folderId ?? body.folder_id);
        const folderId = await resolveFolderId(folderValue);
        item.folders = folderId ? [folderId] : [];
    }

    await item.save();
    const updated = await eagle.item.getById(String(itemId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, item: _pickItemForClient(updated || item) }));
}

async function handleDeleteFolder(req, res, query) {
    if (!requireAuth(req, res, query)) return;

    let body = {};
    try {
        body = await readJsonBody(req, 64 * 1024);
    } catch (e) {
        body = {};
    }

    const folderValue = body.folder || body.folderId || body.folder_id || query.folder || query.folderId || '';
    const folderId = await resolveExistingFolderId(folderValue);
    if (!folderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing folder ID' }));
        return;
    }

    let folder = null;
    try {
        if (typeof eagle.folder.getById === 'function') {
            folder = await eagle.folder.getById(folderId);
        }
    } catch (e) {
        folder = null;
    }
    if (!folder) {
        try {
            const found = await eagle.folder.get({ ids: [folderId] });
            folder = Array.isArray(found) ? found[0] : found;
        } catch (e) {
            folder = null;
        }
    }
    if (!folder) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder not found', folderId }));
        return;
    }

    if (typeof folder.remove === 'function') {
        await folder.remove();
    } else if (typeof folder.delete === 'function') {
        await folder.delete();
    } else if (typeof folder.moveToTrash === 'function') {
        await folder.moveToTrash();
    } else if (typeof eagle.folder.remove === 'function') {
        await eagle.folder.remove(folderId);
    } else if (typeof eagle.folder.delete === 'function') {
        await eagle.folder.delete(folderId);
    } else {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder delete is not supported by this Eagle API version', folderId }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, folderId }));
}

function writeSseEvent(res, eventName, dataObj) {
    if (!res || res.writableEnded) return;
    if (eventName) res.write(`event: ${eventName}\n`);
    const payload = (dataObj === undefined) ? '' : JSON.stringify(dataObj);
    for (const line of String(payload).split('\n')) {
        res.write(`data: ${line}\n`);
    }
    res.write('\n');
}

function writeSseComment(res, comment) {
    if (!res || res.writableEnded) return;
    res.write(`: ${comment || ''}\n\n`);
}

function broadcastSse(eventName, dataObj) {
    for (const client of Array.from(sseClients)) {
        try {
            writeSseEvent(client, eventName, dataObj);
        } catch (e) {
            try { client.end(); } catch {}
            sseClients.delete(client);
        }
    }
}

async function pollItemChangesOnce() {
    if (sseClients.size === 0) return;
    if (!supportsSseItemChangePolling()) {
        broadcastSse('live_unsupported', {
            error: 'eagle.item.getIdsWithModifiedAt is not available in this Eagle version',
            ts: Date.now(),
        });
        for (const client of Array.from(sseClients)) {
            try { client.end(); } catch {}
            sseClients.delete(client);
        }
        ensureSseStoppedIfIdle();
        return;
    }
    if (ssePollInFlight) return;
    ssePollInFlight = true;

    try {
        const idsWithModifiedAt = await eagle.item.getIdsWithModifiedAt();
        const current = new Map();
        for (const row of (idsWithModifiedAt || [])) {
            if (!row || !row.id) continue;
            current.set(String(row.id), row.modifiedAt);
        }

        const added = [];
        const modified = [];
        for (const [id, m] of current.entries()) {
            if (!lastKnownIdsWithModifiedAt.has(id)) {
                added.push(id);
            } else if (lastKnownIdsWithModifiedAt.get(id) !== m) {
                modified.push(id);
            }
        }

        const removed = [];
        for (const id of lastKnownIdsWithModifiedAt.keys()) {
            if (!current.has(id)) removed.push(id);
        }

        // Update baseline first so the next poll is consistent even if clients disconnect mid-broadcast.
        lastKnownIdsWithModifiedAt = current;

        if (added.length || modified.length || removed.length) {
            const sliceIds = (arr) => arr.slice(0, SSE_MAX_IDS_PER_EVENT);
            broadcastSse('items_changed', {
                added_count: added.length,
                modified_count: modified.length,
                removed_count: removed.length,
                added_ids: sliceIds(added),
                modified_ids: sliceIds(modified),
                removed_ids: sliceIds(removed),
                library_path: lastKnownLibraryPath || getCurrentLibraryPath(),
                ts: Date.now(),
            });
        }
    } catch (e) {
        // "error" is a reserved-ish EventSource signal; use a custom event name for payloads.
        broadcastSse('bridge_error', { error: String(e && e.message ? e.message : e), ts: Date.now() });
    } finally {
        ssePollInFlight = false;
    }
}

async function ensureSsePollingStarted() {
    if (sseClients.size === 0) return;
    if (!supportsSseItemChangePolling()) return;

    if (!lastKnownLibraryPath) {
        lastKnownLibraryPath = getCurrentLibraryPath();
    }

    if (lastKnownIdsWithModifiedAt.size === 0) {
        try {
            const idsWithModifiedAt = await eagle.item.getIdsWithModifiedAt();
            const current = new Map();
            for (const row of (idsWithModifiedAt || [])) {
                if (!row || !row.id) continue;
                current.set(String(row.id), row.modifiedAt);
            }
            lastKnownIdsWithModifiedAt = current;
        } catch (e) {
            // keep empty; we'll retry on next poll
        }
    }

    if (!sseHeartbeatTimer) {
        sseHeartbeatTimer = setInterval(() => {
            for (const client of Array.from(sseClients)) {
                try { writeSseComment(client, 'ping'); } catch {}
            }
        }, SSE_HEARTBEAT_MS);
    }

    if (!ssePollTimer) {
        ssePollTimer = setInterval(() => {
            // Fire and forget; broadcast errors to clients.
            pollItemChangesOnce();
        }, SSE_POLL_INTERVAL_MS);
    }
}

function ensureSseStoppedIfIdle() {
    if (sseClients.size !== 0) return;
    if (sseHeartbeatTimer) {
        clearInterval(sseHeartbeatTimer);
        sseHeartbeatTimer = null;
    }
    if (ssePollTimer) {
        clearInterval(ssePollTimer);
        ssePollTimer = null;
    }
    lastKnownIdsWithModifiedAt = new Map();
}

async function handleSseEvents(req, res, query) {
    if (!requireAuth(req, res, query)) return;

    // SSE response headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    // Let clients retry quickly
    res.write('retry: 1500\n\n');

    // Register client
    sseClients.add(res);
    addLog(`SSE client connected (${sseClients.size})`, 'success');

    // Send hello payload
    const liveSupported = supportsSseItemChangePolling();
    writeSseEvent(res, 'hello', {
        ok: liveSupported,
        live_supported: liveSupported,
        error: liveSupported ? undefined : 'eagle.item.getIdsWithModifiedAt is not available in this Eagle version',
        library_path: getCurrentLibraryPath(),
        ts: Date.now(),
    });

    // Start pollers only when at least one client is connected
    if (liveSupported) {
        await ensureSsePollingStarted();
    }

    // Cleanup on disconnect
    req.on('close', () => {
        sseClients.delete(res);
        addLog(`SSE client disconnected (${sseClients.size})`, 'info');
        ensureSseStoppedIfIdle();
    });
}

function parsePositiveInt(value, fallbackValue = null, min = 1, max = 100000) {
    if (value === undefined || value === null || value === '') return fallbackValue;
    const n = parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallbackValue;
    return Math.max(min, Math.min(max, n));
}

function normalizeOutputFormat(value, fallbackFormat = 'jpeg') {
    const fmt = String(value || '').toLowerCase().trim();
    if (fmt === 'jpg' || fmt === 'jpeg') return 'jpeg';
    if (fmt === 'png') return 'png';
    return fallbackFormat;
}

function makeWeakEtag(parts) {
    const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(parts.map(p => p === undefined ? null : p)), 'utf8')
        .digest('base64url');
    return `W/"${hash}"`;
}

function sendNotModifiedIfMatch(req, res, etag, extraHeaders = {}) {
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && String(ifNoneMatch) === String(etag)) {
        res.writeHead(304, { ETag: etag, ...extraHeaders });
        res.end();
        return true;
    }
    return false;
}

function sanitizeFilenameBase(value, fallbackValue = 'eagle-image') {
    const raw = String(value || fallbackValue).replace(/[\\/:*?"<>|]+/g, '_').trim();
    return raw || fallbackValue;
}

function sanitizeAsciiFilename(value, fallbackValue = 'eagle-image') {
    const ascii = sanitizeFilenameBase(value, fallbackValue)
        .normalize('NFKD')
        .replace(/[^\x20-\x7E]+/g, '_')
        .replace(/["\\]/g, '_')
        .replace(/[;]+/g, '_')
        .replace(/_+/g, '_')
        .trim();
    return ascii && ascii !== '_' ? ascii : fallbackValue;
}

function contentDispositionInline(filename) {
    const utf8Name = sanitizeFilenameBase(filename);
    const asciiName = sanitizeAsciiFilename(filename);
    return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}

function cacheGet(key) {
    const hit = resizedCache.get(key);
    if (!hit) return null;
    // LRU: bump to end
    resizedCache.delete(key);
    resizedCache.set(key, hit);
    return hit;
}

function cacheSet(key, value) {
    if (resizedCache.has(key)) {
        const prev = resizedCache.get(key);
        resizedCacheBytes -= prev?.bytes || 0;
        resizedCache.delete(key);
    }
    resizedCache.set(key, value);
    resizedCacheBytes += value?.bytes || 0;

    while (resizedCache.size > RESIZED_CACHE_MAX_ENTRIES || resizedCacheBytes > RESIZED_CACHE_MAX_BYTES) {
        const firstKey = resizedCache.keys().next().value;
        const removed = resizedCache.get(firstKey);
        resizedCacheBytes -= removed?.bytes || 0;
        resizedCache.delete(firstKey);
    }
}

function getNativeImage() {
    if (cachedNativeImage !== undefined) return cachedNativeImage;
    try {
        // Eagle runs on Electron; nativeImage provides simple resize/encode.
        const electron = require('electron');
        cachedNativeImage = electron?.nativeImage || null;
        return cachedNativeImage;
    } catch (e) {
        cachedNativeImage = null;
        return null;
    }
}

function resizeBufferIfNeeded(inputBuffer, maxSize, outputFormat, quality) {
    const nativeImage = getNativeImage();
    if (!nativeImage) {
        throw new Error('nativeImage is not available');
    }

    const image = nativeImage.createFromBuffer(inputBuffer);
    if (!image || image.isEmpty()) {
        throw new Error('Unsupported image buffer');
    }

    const size = image.getSize();
    const maxDim = Math.max(size.width || 0, size.height || 0);
    if (!maxDim || maxDim <= maxSize) {
        // No resize needed; just re-encode if requested.
        if (outputFormat === 'png') return { buffer: image.toPNG(), mimeType: 'image/png' };
        return { buffer: image.toJPEG(quality), mimeType: 'image/jpeg' };
    }

    const scale = maxSize / maxDim;
    const width = Math.max(1, Math.round((size.width || 1) * scale));
    const height = Math.max(1, Math.round((size.height || 1) * scale));
    const resized = image.resize({ width, height, quality: 'best' });

    if (outputFormat === 'png') return { buffer: resized.toPNG(), mimeType: 'image/png' };
    return { buffer: resized.toJPEG(quality), mimeType: 'image/jpeg' };
}

async function handleGetImageFile(req, res, query) {
    // If a token is configured, require it for raw file access.
    if (!requireAuth(req, res, query)) return;

    const itemId = query.id;
    const debugImage = query.debug === '1' || query.debug === 'true';
    const requestId = query.rid ? String(query.rid) : '';
    if (!itemId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing item ID' }));
        return;
    }

    const item = await getItemByIdWithOwnedFilePath(itemId, "image-file");
    if (!item || !item.filePath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Item not found' }));
        return;
    }
    if (String(item.id || "") !== String(itemId)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Eagle returned a different item', requested: String(itemId), actual: item.id || null }));
        return;
    }
    if (!pathBelongsToItemInfo(item.filePath, itemId)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Eagle returned a filePath for a different item',
            requested: String(itemId),
            actual: item.id || null,
            filePath: item.filePath || '',
        }));
        return;
    }

    const filePath = item.filePath;
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
    }

    const maxSize = parsePositiveInt(query.max_size, null, 16, 8192);
    const outputFormat = normalizeOutputFormat(query.format, 'jpeg');
    const quality = parsePositiveInt(query.quality, 85, 1, 100);

    const stat = fs.statSync(filePath);
    const sourceKey = `${itemId}|${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;

    const ext = (path.extname(filePath || '').replace('.', '') || item.ext || 'jpg');
    const mimeType = getMimeType(ext);
    const safeName = sanitizeFilenameBase(item.name ? String(item.name) : String(itemId));
    const fileName = `${safeName}.${ext}`;
    const imageHeaders = {
        'X-Eagle-Item-Id': String(itemId),
        'X-Eagle-File-Path': encodeURIComponent(String(filePath)),
        'X-Eagle-Request-Id': requestId,
    };
    if (debugImage) {
        addLog(
            `[Image file] rid=${requestId} id=${itemId} name="${safeName}" filePath="${filePath}" bytes=${stat.size} mime=${mimeType}`,
            'info'
        );
    }

    if (maxSize && getNativeImage()) {
        const cacheControl = 'private, max-age=0, must-revalidate';
        const etag = makeWeakEtag([sourceKey, 'max', maxSize, outputFormat, quality]);
        if (sendNotModifiedIfMatch(req, res, etag, { 'Cache-Control': cacheControl })) return;

        const cacheKey = `image|${etag}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
            res.writeHead(200, {
                'Content-Type': cached.mimeType,
                'Content-Disposition': contentDispositionInline(`${safeName}.${outputFormat === 'png' ? 'png' : 'jpg'}`),
                'Cache-Control': cacheControl,
                'ETag': cached.etag,
                ...imageHeaders,
            });
            res.end(cached.buffer);
            return;
        }

        try {
            const inputBuffer = fs.readFileSync(filePath);
            const resized = resizeBufferIfNeeded(inputBuffer, maxSize, outputFormat, quality);
            cacheSet(cacheKey, { buffer: resized.buffer, mimeType: resized.mimeType, etag, bytes: resized.buffer.length });
            res.writeHead(200, {
                'Content-Type': resized.mimeType,
                'Content-Disposition': contentDispositionInline(`${safeName}.${outputFormat === 'png' ? 'png' : 'jpg'}`),
                'Cache-Control': cacheControl,
                'ETag': etag,
                ...imageHeaders,
            });
            res.end(resized.buffer);
            return;
        } catch (e) {
            addLog(`Resize failed (serving original): ${e.message}`, 'error');
            // Fall through to original stream (no-store) for compatibility.
        }
    }

    res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': contentDispositionInline(fileName),
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
        ...imageHeaders,
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
        addLog(`File stream error: ${err.message}`, 'error');
        try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read file' }));
        } catch (e) {
            // ignore
        }
    });
    stream.pipe(res);
}

async function handleGetThumbnailFile(req, res, query) {
    // If a token is configured, require it for raw file access.
    if (!requireAuth(req, res, query)) return;

    const itemId = query.id;
    if (!itemId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing item ID' }));
        return;
    }

    const item = await getItemByIdWithOwnedMediaPath(itemId, `thumbnail rid=${query.rid || ""}`);
    if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Item not found' }));
        return;
    }
    if (String(item.id || "") !== String(itemId)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Eagle returned a different item', requested: String(itemId), actual: item.id || null }));
        return;
    }

    const originalThumbPath = item.thumbnailPath || '';
    let sourcePath = originalThumbPath;
    let sourceKind = 'thumbnailPath';
    const thumbnailMatchesItem = pathBelongsToItemInfo(originalThumbPath, itemId);
    const filePathMatchesItem = pathBelongsToItemInfo(item.filePath, itemId);

    if (!thumbnailMatchesItem && filePathMatchesItem && fs.existsSync(item.filePath)) {
        sourcePath = item.filePath;
        sourceKind = 'filePath';
    } else if (!thumbnailMatchesItem) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Eagle returned item media paths for a different item',
            requested: String(itemId),
            actual: item.id || null,
            thumbnailPath: originalThumbPath,
            filePath: item.filePath || '',
        }));
        return;
    }

    if (!sourcePath || !fs.existsSync(sourcePath)) {
        if (sourcePath !== item.filePath && filePathMatchesItem && item.filePath && fs.existsSync(item.filePath)) {
            sourcePath = item.filePath;
            sourceKind = 'filePath';
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Thumbnail source not found' }));
            return;
        }
    }

    if (!fs.existsSync(sourcePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Thumbnail source file not found' }));
        return;
    }

    const maxSize = parsePositiveInt(query.max_size, null, 16, 2048);
    const outputFormat = normalizeOutputFormat(query.format, 'jpeg');
    const quality = parsePositiveInt(query.quality, 85, 1, 100);
    const bypassCache = query.no_cache === '1' || query.no_cache === 'true';
    const debugThumb = query.debug === '1' || query.debug === 'true';
    const requestId = query.rid ? String(query.rid) : '';

    const stat = fs.statSync(sourcePath);
    const sourceKey = `${itemId}|${sourcePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
    const thumbExt = (path.extname(sourcePath || '').replace('.', '') || item.ext || 'jpg');
    const sourceMimeType = getMimeType(thumbExt);
    const safeName = sanitizeFilenameBase(item.name ? String(item.name) : String(itemId));
    const canResizeThumbnail = !!(maxSize && getNativeImage());
    const etag = makeWeakEtag([sourceKey, 'thumb', canResizeThumbnail ? maxSize : 'orig', canResizeThumbnail ? outputFormat : thumbExt, quality]);
    const cacheControl = bypassCache ? 'no-store' : 'private, max-age=0, must-revalidate';
    const itemHeaders = {
        'X-Eagle-Item-Id': String(itemId),
        'X-Eagle-Thumbnail-Path': encodeURIComponent(String(originalThumbPath || '')),
        'X-Eagle-Served-Path': encodeURIComponent(String(sourcePath)),
        'X-Eagle-Served-Source': sourceKind,
        'X-Eagle-Thumbnail-Mismatch': thumbnailMatchesItem ? '0' : '1',
        'X-Eagle-Request-Id': requestId,
    };
    const logThumb = (stage, extra = {}) => {
        if (!debugThumb) return;
        addLog(
            `[Thumb ${stage}] rid=${requestId} id=${itemId} name="${safeName}" ` +
            `thumb_path="${originalThumbPath}" served_path="${sourcePath}" source=${sourceKind} ` +
            `mismatch=${thumbnailMatchesItem ? 0 : 1} bypass=${bypassCache} resize=${canResizeThumbnail} ` +
            Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' '),
            'info'
        );
    };
    logThumb('start', { max: maxSize || '', format: outputFormat, mime: sourceMimeType, source_bytes: stat.size });
    if (!bypassCache && sendNotModifiedIfMatch(req, res, etag, { 'Cache-Control': cacheControl, ...itemHeaders })) return;

    const cacheKey = `thumb|${etag}`;
    const cached = bypassCache ? null : cacheGet(cacheKey);
    if (cached) {
        logThumb('cached', { bytes: cached.buffer.length, mime: cached.mimeType });
        res.writeHead(200, {
            'Content-Type': cached.mimeType,
            'Content-Disposition': contentDispositionInline(`${safeName}.${outputFormat === 'png' ? 'png' : 'jpg'}`),
            'Cache-Control': cacheControl,
            'ETag': cached.etag,
            'Content-Length': cached.buffer.length,
            ...itemHeaders,
        });
        res.end(cached.buffer);
        return;
    }

    if (!canResizeThumbnail) {
        logThumb('stream-original', { bytes: stat.size, mime: sourceMimeType });
        res.writeHead(200, {
            'Content-Type': sourceMimeType,
            'Content-Disposition': contentDispositionInline(`${safeName}.${thumbExt}`),
            'Cache-Control': cacheControl,
            ...(bypassCache ? {} : { 'ETag': etag }),
            'Content-Length': stat.size,
            ...itemHeaders,
        });
        const stream = fs.createReadStream(sourcePath);
        stream.on('error', (err) => {
            addLog(`Thumbnail stream error: ${err.message}`, 'error');
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read thumbnail file' }));
            } catch (e) {
                // ignore
            }
        });
        stream.pipe(res);
        return;
    }

    try {
        const inputBuffer = fs.readFileSync(sourcePath);
        const resized = resizeBufferIfNeeded(inputBuffer, maxSize, outputFormat, quality);
        if (!bypassCache) {
            cacheSet(cacheKey, { buffer: resized.buffer, mimeType: resized.mimeType, etag, bytes: resized.buffer.length });
        }
        logThumb('resized', { bytes: resized.buffer.length, mime: resized.mimeType });
        res.writeHead(200, {
            'Content-Type': resized.mimeType,
            'Content-Disposition': contentDispositionInline(`${safeName}.${outputFormat === 'png' ? 'png' : 'jpg'}`),
            'Cache-Control': cacheControl,
            ...(bypassCache ? {} : { 'ETag': etag }),
            'Content-Length': resized.buffer.length,
            ...itemHeaders,
        });
        res.end(resized.buffer);
    } catch (e) {
        addLog(`Thumbnail resize failed (serving original): ${e.message}`, 'error');
        logThumb('resize-fallback', { bytes: stat.size, mime: sourceMimeType, error: JSON.stringify(e.message || String(e)) });
        res.writeHead(200, {
            'Content-Type': sourceMimeType,
            'Content-Disposition': contentDispositionInline(`${safeName}.${thumbExt}`),
            'Cache-Control': cacheControl,
            ...(bypassCache ? {} : { 'ETag': etag }),
            'Content-Length': stat.size,
            ...itemHeaders,
        });
        const stream = fs.createReadStream(sourcePath);
        stream.on('error', (err) => {
            addLog(`Thumbnail stream error: ${err.message}`, 'error');
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read thumbnail file' }));
            } catch (e2) {
                // ignore
            }
        });
        stream.pipe(res);
    }
}

async function handleThumbnail(req, res, query) {
    const itemId = query.id;
    
    if (!itemId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing item ID' }));
        return;
    }
    
    const item = await getItemByIdStrict(itemId, "thumbnail-base64");
    
    if (!item || !item.thumbnailPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Thumbnail not found' }));
        return;
    }
    if (String(item.id || "") !== String(itemId)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Eagle returned a different item', requested: String(itemId), actual: item.id || null }));
        return;
    }
    
    // サムネイルをBase64で送信
    const imageBuffer = fs.readFileSync(item.thumbnailPath);
    const base64 = imageBuffer.toString('base64');
    const thumbExt = (path.extname(item.thumbnailPath || '').replace('.', '') || item.ext || 'jpg');
    const mimeType = getMimeType(thumbExt);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        thumbnail: `data:${mimeType};base64,${base64}`,
        name: item.name,
        id: item.id
    }));
}

// 画像パス取得API
async function handleGetImage(req, res, query) {
    const itemId = query.id;
    const debugImage = query.debug === '1' || query.debug === 'true';
    const requestId = query.rid ? String(query.rid) : '';

    if (!itemId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing item ID' }));
        return;
    }

    const item = await getItemByIdWithOwnedFilePath(itemId, "get-image");
    
    if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Item not found' }));
        return;
    }
    if (String(item.id || "") !== String(itemId)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Eagle returned a different item', requested: String(itemId), actual: item.id || null }));
        return;
    }
    if (!pathBelongsToItemInfo(item.filePath, itemId)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Eagle returned a filePath for a different item',
            requested: String(itemId),
            actual: item.id || null,
            filePath: item.filePath || '',
        }));
        return;
    }
    
    if (debugImage) {
        addLog(
            `[Get image] rid=${requestId} id=${itemId} name="${item.name}" filePath="${item.filePath}" ext=${item.ext} size=${item.size || ""}`,
            'info'
        );
    } else {
        addLog(`Get image: ${item.name}`, 'success');
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: item.id,
        name: item.name,
        filePath: item.filePath,
        ext: item.ext,
        width: item.width,
        height: item.height,
        tags: item.tags,
        annotation: item.annotation
    }));
}

// フォルダ一覧取得API
async function handleGetFolders(req, res) {
    const folders = await getAllFoldersFlat();

    const byId = new Map();
    for (const folder of folders || []) {
        if (folder && folder.id) {
            byId.set(String(folder.id), folder);
        }
    }

    const pathCache = new Map();
    function pathFor(id, depth = 0) {
        const key = String(id);
        if (pathCache.has(key)) return pathCache.get(key);
        const folder = byId.get(key);
        if (!folder) {
            pathCache.set(key, key);
            return key;
        }
        if (depth > 50) {
            const fallback = folder.name || key;
            pathCache.set(key, fallback);
            return fallback;
        }
        const name = folder.name || key;
        if (folder.parent && byId.has(String(folder.parent))) {
            const parentPath = pathFor(folder.parent, depth + 1);
            const fullPath = `${parentPath}/${name}`;
            pathCache.set(key, fullPath);
            return fullPath;
        }
        pathCache.set(key, name);
        return name;
    }

    const folderList = (folders || []).map(f => ({
        id: f.id,
        name: f.name,
        description: f.description,
        parent: f.parent,
        depth: Number.isFinite(Number(f.depth)) ? Number(f.depth) : 0,
        path: pathFor(f.id),
    })).sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ folders: folderList }));
}

// タグ一覧取得API
async function handleGetTags(req, res) {
    const tags = await eagle.tag.get();
    const tagList = tags.map(t => ({
        name: t.name,
        count: t.count,
        color: t.color
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tags: tagList }));
}

// 統計情報取得API
async function handleGetStats(req, res) {
    const allItems = await eagle.item.countAll();
    const library = eagle.library;
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        totalItems: allItems,
        libraryName: library.name,
        libraryPath: library.path
    }));
}

// ヘルパー関数
function getMimeType(ext) {
    const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'svg': 'image/svg+xml'
    };
    return mimeTypes[ext.toLowerCase()] || 'image/jpeg';
}

function updateStatus(status, port) {
    if (statusElement) {
        statusElement.textContent = status;
        statusElement.className = 'status-value' + (status === 'Running' ? '' : ' inactive');
    }
    if (portElement && port !== '-') {
        portElement.textContent = port;
    }
}

function updateRequestCount() {
    if (countElement) {
        countElement.textContent = requestCount;
    }
}

function addLog(message, type = 'info') {
    console.log(message);
    
    if (logElement) {
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = 'log-entry' + (type !== 'info' ? ` ${type}` : '');
        entry.textContent = `[${timestamp}] ${message}`;
        logElement.insertBefore(entry, logElement.firstChild);
        
        // 最大100エントリーまで保持
        while (logElement.children.length > 100) {
            logElement.removeChild(logElement.lastChild);
        }
    }
}
