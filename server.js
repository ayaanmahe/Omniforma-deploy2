const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const AdmZip   = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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
    // Get list of jobs for this run
    const jobsRes  = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/jobs`,
      { headers: GH_HEADERS }
    );
    const jobsData = await jobsRes.json();
    const job      = jobsData.jobs?.[0];
    if (!job) return 'Compile failed — no job found';

    // Download the log for this job
    const logRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/jobs/${job.id}/logs`,
      { headers: GH_HEADERS, redirect: 'follow' }
    );
    const logText = await logRes.text();

    // Extract Arduino compiler error lines
    // These look like: sketch.ino:6:3: error: 'Seial' was not declared
    const errorLines = logText
      .split('\n')
      .filter(line =>
        line.includes(': error:') ||
        line.includes(': warning:') ||
        line.includes('undefined reference') ||
        line.includes('ld returned') ||
        line.includes('collect2:')
      )
      .map(line => {
        // Strip GitHub Actions log timestamp prefix (e.g. "2024-01-01T00:00:00.0000000Z ")
        return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '').trim();
      })
      .filter(line => line.length > 0)
      // Clean up path — replace /tmp/sketch/sketch/ with empty
      .map(line => line.replace(/\/tmp\/sketch\/sketch\//g, ''))
      .slice(0, 10); // max 10 error lines

    if (errorLines.length > 0) {
      return errorLines.join('\n');
    }

    // Fallback — look for any error keyword
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
        body: JSON.stringify({ ref: 'main', inputs: { code, fqbn } })
      }
    );

    if (!triggerRes.ok) {
      const err = await triggerRes.text();
      return res.json({ success: false, error: 'Failed to trigger workflow: ' + err });
    }

    // ── 2. Wait for workflow to appear ───────────────────────
    await new Promise(r => setTimeout(r, 5000));

    // ── 3. Get latest run ID ─────────────────────────────────
    const runsRes  = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=1&event=workflow_dispatch`,
      { headers: GH_HEADERS }
    );
    const runsData = await runsRes.json();
    const runId    = runsData.workflow_runs?.[0]?.id;
    if (!runId) return res.json({ success: false, error: 'Could not find workflow run' });

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
    const artifact      = artifactsData.artifacts?.find(a => a.name === 'compiled-hex');
    if (!artifact) return res.json({ success: false, error: 'HEX artifact not found' });

    const zipRes    = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
      { headers: GH_HEADERS, redirect: 'follow' }
    );
    const zipBuffer = await zipRes.buffer();

    // ── 7. Extract HEX from zip ──────────────────────────────
    const zip      = new AdmZip(zipBuffer);
    const hexEntry = zip.getEntries().find(e => e.entryName.endsWith('.hex'));
    if (!hexEntry) return res.json({ success: false, error: 'HEX file not found in artifact' });

    const hex = zip.readAsText(hexEntry);
    console.log('HEX extracted successfully');

    res.json({ success: true, hex, stdout: 'Compiled via GitHub Actions' });

  } catch(e) {
    console.error('Compile error:', e);
    res.json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('Arduino Compile Server (GitHub Actions) running'));

app.listen(3000, () => console.log('Server on port 3000'));
