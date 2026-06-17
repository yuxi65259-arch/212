// 212 宿舍照片上传服务器
// 运行: node upload-server.js
// 然后在浏览器打开 http://localhost:3456

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const GH_TOKEN = process.env.GH_TOKEN || require("fs").readFileSync(require("path").join(require("os").homedir(), ".claude", "gh_token"), "utf-8").trim();
const GH_OWNER = 'yuxi65259-arch';
const GH_REPO = '212';

// Serve the page
const HTML_PATH = path.join(__dirname, 'index.html');
const MAX_BODY_BYTES = 250 * 1024 * 1024;
const BATCH_LIMIT = 50;

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function githubHeaders() {
  return {
    'Authorization': `token ${GH_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'dormitory-memorial-uploader'
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large. Please upload fewer photos per batch.'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function decodeGitHubJsonContent(content) {
  return JSON.parse(Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8'));
}

async function getPhotosIndex() {
  const resp = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/photos.json`, {
    headers: githubHeaders()
  });
  if (!resp.ok) return { photos: [], sha: null };
  const data = await resp.json();
  return { photos: decodeGitHubJsonContent(data.content), sha: data.sha };
}

function emptyFaceIndex() {
  return { version: 1, people: [], photoFaces: {}, updatedAt: null };
}

function normalizeFaceIndex(data) {
  const next = data && typeof data === 'object' ? data : emptyFaceIndex();
  next.version = next.version || 1;
  next.people = Array.isArray(next.people) ? next.people : [];
  next.photoFaces = next.photoFaces && typeof next.photoFaces === 'object' ? next.photoFaces : {};
  next.updatedAt = next.updatedAt || null;
  next.people.forEach(person => {
    if (!Array.isArray(person.descriptors)) {
      person.descriptors = person.descriptor ? [person.descriptor] : [];
    }
  });
  return next;
}

async function getFacesIndex() {
  const resp = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/faces.json`, {
    headers: githubHeaders()
  });
  if (!resp.ok) return { faces: emptyFaceIndex(), sha: null };
  const data = await resp.json();
  return { faces: normalizeFaceIndex(decodeGitHubJsonContent(data.content)), sha: data.sha };
}

async function saveFacesIndex(nextFaces, sha) {
  const faces = normalizeFaceIndex(nextFaces);
  faces.updatedAt = new Date().toISOString();
  const body = {
    message: 'Update face index',
    content: Buffer.from(JSON.stringify(faces, null, 2)).toString('base64')
  };
  if (sha) body.sha = sha;

  const resp = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/faces.json`, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to save faces.json: ${errText.slice(0, 200)}`);
  }
  return faces;
}

async function savePhotosIndex(nextPhotos, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(nextPhotos, null, 2)).toString('base64')
  };
  if (sha) body.sha = sha;

  return fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/photos.json`, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify(body)
  });
}

async function uploadPhotoFile(item, cat, uploader) {
  const image = item.image || '';
  const base64 = image.split(',')[1] || image;
  if (!base64) throw new Error('Missing image data');

  const filename = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const ghResp = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/photos/${filename}`, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify({
      message: `Add photo: ${filename}`,
      content: base64
    })
  });

  if (!ghResp.ok) {
    const errText = await ghResp.text();
    throw new Error(`GitHub upload failed: ${errText.slice(0, 200)}`);
  }

  const ghData = await ghResp.json();
  return {
    id: 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    cat: item.cat || cat || 'daily',
    url: ghData.content.download_url,
    api_url: ghData.content.git_url,
    label: item.label || filename,
    date: new Date().toISOString().slice(0, 10),
    uploader: uploader || ''
  };
}

async function savePhotosWithRetry(newPhotos, message) {
  for (let retry = 0; retry < 3; retry++) {
    const { photos, sha } = await getPhotosIndex();
    const seen = new Set(photos.map(p => p.id));
    const merged = photos.concat(newPhotos.filter(p => !seen.has(p.id)));
    const updateResp = await savePhotosIndex(merged, sha, message);
    if (updateResp.ok) return merged.length;
    if (updateResp.status !== 409) {
      const errText = await updateResp.text();
      throw new Error(`Failed to update photos.json: ${errText.slice(0, 200)}`);
    }
  }
  throw new Error('Failed to update photos.json after retries');
}

function serveFile(res, filePath, type) {
  fs.readFile(filePath, 'utf-8', (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /api/photos - fetch photos list
  if (pathname === '/api/photos' && req.method === 'GET') {
    try {
      const { photos } = await getPhotosIndex();
      jsonResponse(res, 200, photos);
    } catch(e) {
      jsonResponse(res, 200, []);
    }
    return;
  }

  // GET /api/faces - fetch shared face index
  if (pathname === '/api/faces' && req.method === 'GET') {
    try {
      const { faces } = await getFacesIndex();
      jsonResponse(res, 200, faces);
    } catch(e) {
      jsonResponse(res, 200, emptyFaceIndex());
    }
    return;
  }

  // PUT /api/faces - save shared face index
  if (pathname === '/api/faces' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const { sha } = await getFacesIndex();
      const faces = await saveFacesIndex(body, sha);
      jsonResponse(res, 200, faces);
    } catch(e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/upload-batch - upload up to 50 photos and update photos.json once
  if (pathname === '/api/upload-batch' && req.method === 'POST') {
    try {
      const { photos: incoming, cat, uploader } = await readJsonBody(req);
      const items = Array.isArray(incoming) ? incoming : [];
      if (!items.length) {
        jsonResponse(res, 400, { error: 'No photos provided' });
        return;
      }
      if (items.length > BATCH_LIMIT) {
        jsonResponse(res, 400, { error: `Too many photos in one batch. Max is ${BATCH_LIMIT}.` });
        return;
      }

      const uploaded = [];
      const failed = [];
      for (const item of items) {
        try {
          uploaded.push(await uploadPhotoFile(item, cat, uploader));
        } catch (e) {
          failed.push({ label: item.label || '', error: e.message });
        }
      }

      let count = null;
      if (uploaded.length) {
        count = await savePhotosWithRetry(uploaded, `Add ${uploaded.length} photos`);
      }

      jsonResponse(res, failed.length ? 207 : 200, {
        success: failed.length === 0,
        uploaded,
        failed,
        count
      });
    } catch(e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/upload - upload photo
  if (pathname === '/api/upload' && req.method === 'POST') {
    try {
      const item = await readJsonBody(req);
      const uploaded = await uploadPhotoFile(item, item.cat, item.uploader);
      const count = await savePhotosWithRetry([uploaded], `Add photo: ${uploaded.label}`);
      jsonResponse(res, 200, { success: true, photo: uploaded, url: uploaded.url, count });
    } catch(e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // DELETE /api/photos/:id - delete photo
  const delMatch = pathname.match(/^\/api\/photos\/(.+)$/);
  if (delMatch && req.method === 'DELETE') {
    const photoId = delMatch[1];
    try {
      const currentResp = await fetch(`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/main/photos.json`);
      if (!currentResp.ok) { res.writeHead(404); res.end('Not found'); return; }
      let photos = await currentResp.json();
      const removed = photos.find(p => p.id === photoId);
      photos = photos.filter(p => p.id !== photoId);

      let sha = null;
      try {
        const existing = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/photos.json`, {
          headers: { 'Authorization': `token ${GH_TOKEN}` }
        });
        if (existing.ok) sha = (await existing.json()).sha;
      } catch(e) {}

      await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/photos.json`, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Delete photo: ${photoId}`,
          content: Buffer.from(JSON.stringify(photos, null, 2)).toString('base64'),
          sha: sha
        })
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: photos.length }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve the HTML file
  serveFile(res, HTML_PATH, 'text/html');
}

const server = http.createServer(handleAPI);
server.listen(PORT, () => {
  console.log(`
  🎓 212 宿舍纪念册 - 上传服务已启动
  ====================================
  在浏览器打开: http://localhost:${PORT}
  照片将自动同步到 GitHub 仓库
  不限照片数量，所有设备同步
  ====================================
  按 Ctrl+C 停止服务
  `);
});
