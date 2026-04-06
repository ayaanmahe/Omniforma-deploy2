const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const AdmZip   = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// In-memory store for the latest compiled firmware binary
const firmwareStore = {};  // { token: { bin: Buffer, manifest: Object } }

// ── GET /firmware/:token/firmware.bin ────────────────────────
app.get('/firmware/:token/firmware.bin', (req, res) => {
  const entry = firmwareStore[req.params.token];
  if (!entry) return res.status(404).send('Firmware not found or expired');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(entry.bin);
});

// ── GET /firmware/:token/manifest.json ───────────────────────
app.get('/firmware/:token/manifest.json', (req, res) => {
  const entry = firmwareStore[req.params.token];
  if (!entry) return res.status(404).send('Manifest not found or expired');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(entry.manifest);
});

// ── GET /firmware/:token/:filename (serves bin by filename) ──
app.get('/firmware/:token/:filename', (req, res) => {
  const entry = firmwareStore[req.params.token];
  if (!entry) return res.status(404).send('Firmware not found or expired');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(entry.bin);
});

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const POLL_INTERVAL = 5000;
const MAX_WAIT      = 300000;

const GH_HEADERS = {
  'Authorization': `Bearer ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

// ── Fetch and parse error from Actions log ──────────────────
async function getActionsError(runId) {
  try {
    const jobsRes  = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/jobs`,
      { headers: GH_HEADERS }
    );
    const jobsData = await jobsRes.json();
    const job      = jobsData.jobs?.[0];
    if (!job) return 'Compile failed — no job found';

    const logRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/jobs/${job.id}/logs`,
      { headers: GH_HEADERS, redirect: 'follow' }
    );
    const logText = await logRes.text();

    const errorLines = logText
      .split('\n')
      .filter(line =>
        line.includes(': error:') ||
        line.includes(': warning:') ||
        line.includes('undefined reference') ||
        line.includes('ld returned') ||
        line.includes('collect2:')
      )
      .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '').trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/\/tmp\/sketch\/sketch\//g, ''))
      .slice(0, 10);

    if (errorLines.length > 0) return errorLines.join('\n');

    const fallback = logText
      .split('\n')
      .filter(line => line.toLowerCase().includes('error') && !line.includes('::set-output'))
      .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '').trim())
      .slice(0, 5)
      .join('\n');

    return fallback || 'Compile failed — unknown error';

  } catch(e) {
    return 'Compile failed — could not fetch error details: ' + e.message;
  }
}

// ── POST /compile ────────────────────────────────────────────
app.post('/compile', async (req, res) => {
  const { code, fqbn = 'arduino:avr:uno' } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Server not configured — missing GitHub env vars' });
  }

  console.log('Triggering GitHub Actions compile...');

  try {
    // ── 1. Trigger workflow ──────────────────────────────────
    const triggerRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/compile.yml/dispatches`,
      {
        method: 'POST',
        headers: GH_HEADERS,
        body: JSON.stringify({ ref: 'test', inputs: { code, fqbn } })
      }
    );

    if (!triggerRes.ok) {
      const err = await triggerRes.text();
      return res.json({ success: false, error: 'Failed to trigger workflow: ' + err });
    }

    // ── 2. Wait for workflow to appear ───────────────────────
    const triggerTime = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5000));

    // ── 3. Get latest run ID ─────────────────────────────────
    let runId = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const runsRes  = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=5&event=workflow_dispatch`,
        { headers: GH_HEADERS }
      );
      const runsData = await runsRes.json();
      const match = runsData.workflow_runs?.find(r => r.created_at >= triggerTime);
      if (match) { runId = match.id; break; }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!runId) return res.json({ success: false, error: 'Could not find workflow run — try again' });

    console.log('Run ID:', runId);

    // ── 4. Poll until complete ───────────────────────────────
    const startTime = Date.now();
    let status = 'in_progress';
    let conclusion = null;

    while (status !== 'completed') {
      if (Date.now() - startTime > MAX_WAIT) {
        return res.json({ success: false, error: 'Compile timed out after 5 minutes' });
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      const runRes  = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`,
        { headers: GH_HEADERS }
      );
      const runData = await runRes.json();
      status        = runData.status;
      conclusion    = runData.conclusion;
      console.log('Status:', status, '| Conclusion:', conclusion);
    }

    // ── 5. If failed — fetch real error from logs ────────────
    if (conclusion !== 'success') {
      const errorMsg = await getActionsError(runId);
      return res.json({ success: false, error: errorMsg });
    }

    // ── 6. Download artifact ─────────────────────────────────
    const artifactsRes  = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/artifacts`,
      { headers: GH_HEADERS }
    );
    const artifactsData = await artifactsRes.json();
    const artifact      = artifactsData.artifacts?.find(a => a.name === 'compiled-firmware');
    if (!artifact) return res.json({ success: false, error: 'Firmware artifact not found' });

    const zipRes    = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
      { headers: GH_HEADERS, redirect: 'follow' }
    );
    const zipBuffer = await zipRes.buffer();

    // ── 7. Extract firmware.bin + manifest.json from zip ─────
    const zip           = new AdmZip(zipBuffer);
    const binEntry      = zip.getEntries().find(e => e.entryName.endsWith('.bin') || e.entryName.endsWith('.hex'));
    const manifestEntry = zip.getEntries().find(e => e.entryName === 'manifest.json');

    if (!binEntry) return res.json({ success: false, error: 'Firmware binary not found in artifact' });

    const binBuffer = zip.readFile(binEntry);
    const isHex     = binEntry.entryName.endsWith('.hex');

    console.log('Firmware extracted successfully:', binEntry.entryName);

    if (isHex) {
      return res.json({ success: true, isHex: true, hex: binBuffer.toString('utf8'), stdout: 'Compiled via GitHub Actions' });
    }

    // ── 8. ESP32 / ESP8266: store binary, keep relative paths in manifest ──
    const token   = runId.toString();
    const proto   = req.get('x-forwarded-proto') || req.protocol;
    const baseUrl = `${proto}://${req.get('host')}/firmware/${token}`;

    // Determine chip family from fqbn
    let chipFamily = 'ESP32';
    if (fqbn.includes('8266')) chipFamily = 'ESP8266';

    // Determine bin filename for the manifest
    const binFileName = chipFamily === 'ESP8266' ? 'esp8266.bin' : 'esp32.bin';

    let manifest;
    if (manifestEntry) {
      // Use manifest from artifact but keep paths relative (just the filename)
      manifest = JSON.parse(zip.readAsText(manifestEntry));
      manifest.builds = manifest.builds.map(b => ({
        ...b,
        parts: b.parts.map(p => ({
          ...p,
          path: binFileName  // ← relative filename only, NOT absolute URL
        }))
      }));
    } else {
      // Build a default manifest with relative path
      manifest = {
        name: 'Omniforma Firmware',
        version: `ci-${runId}`,
        builds: [
          {
            chipFamily,
            parts: [{ path: binFileName, offset: 0 }]  // ← relative filename only
          }
        ]
      };
    }

    firmwareStore[token] = { bin: binBuffer, manifest };
    setTimeout(() => { delete firmwareStore[token]; }, 30 * 60 * 1000); // expire in 30 min

    res.json({
      success:     true,
      isHex:       false,
      manifestUrl: `${baseUrl}/manifest.json`,
      stdout:      'Compiled via GitHub Actions'
    });

  } catch(e) {
    console.error('Compile error:', e);
    res.json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('Arduino Compile Server (GitHub Actions) running'));

app.listen(3000, () => console.log('Server on port 3000'));
