const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Config — set these in Render environment variables ──────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;   // your PAT
const GITHUB_OWNER = process.env.GITHUB_OWNER;   // your GitHub username
const GITHUB_REPO  = process.env.GITHUB_REPO;    // your repo name
const POLL_INTERVAL = 5000;  // check every 5 seconds
const MAX_WAIT      = 300000; // wait max 5 minutes

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
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { code, fqbn }
        })
      }
    );

    if (!triggerRes.ok) {
      const err = await triggerRes.text();
      return res.json({ success: false, error: 'Failed to trigger workflow: ' + err });
    }

    console.log('Workflow triggered — waiting for completion...');

    // ── 2. Wait for workflow to appear ───────────────────────
    await new Promise(r => setTimeout(r, 5000));

    // ── 3. Get the latest workflow run ID ────────────────────
    const runsRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=1&event=workflow_dispatch`,
      {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        }
      }
    );
    const runsData = await runsRes.json();
    const runId = runsData.workflow_runs?.[0]?.id;
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

      const runRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`,
        {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
          }
        }
      );
      const runData = await runRes.json();
      status     = runData.status;
      conclusion = runData.conclusion;
      console.log('Status:', status, '| Conclusion:', conclusion);
    }

    if (conclusion !== 'success') {
      // Get logs for error message
      const logsRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/logs`,
        {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
          }
        }
      );
      return res.json({ success: false, error: 'Compile failed — check GitHub Actions logs for run ' + runId });
    }

    // ── 5. Download artifact ─────────────────────────────────
    const artifactsRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/artifacts`,
      {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        }
      }
    );
    const artifactsData = await artifactsRes.json();
    const artifact = artifactsData.artifacts?.find(a => a.name === 'compiled-hex');
    if (!artifact) return res.json({ success: false, error: 'HEX artifact not found' });

    // Download the zip containing the hex
    const zipRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`,
      {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        },
        redirect: 'follow'
      }
    );

    const zipBuffer = await zipRes.buffer();

    // ── 6. Unzip and extract HEX ─────────────────────────────
    const AdmZip = require('adm-zip');
    const zip    = new AdmZip(zipBuffer);
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
