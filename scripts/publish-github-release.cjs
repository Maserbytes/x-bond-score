const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function getGitHubToken() {
  const input = 'protocol=https\nhost=github.com\n\n';
  const res = spawnSync('git', ['credential', 'fill'], { input, encoding: 'utf8' });
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('password=')) {
      return line.substring('password='.length).trim();
    }
  }
  return null;
}

async function main() {
  const token = getGitHubToken();
  if (!token) {
    console.error('No GitHub token found');
    process.exit(1);
  }

  const repo = 'Maserbytes/x-bond-score';
  const tag = 'v1.5.9';
  const name = 'BondScore v1.5.9';
  const bodyPath = path.join('D:/x-bond-score/docs/releases/v1.5.9.md');
  const body = fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath, 'utf8') : 'BondScore release v1.5.9';

  console.log(`Creating release ${tag} on ${repo}...`);
  const createRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node-Release-Uploader',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: name,
      body: body,
      draft: false,
      prerelease: false
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error('Failed to create release:', createRes.status, errText);
    process.exit(1);
  }

  const release = await createRes.json();
  console.log('Created release:', release.html_url);
  console.log('Upload URL:', release.upload_url);

  // Upload asset: bondscore-v1.5.9-production.zip
  const zipPath = 'D:/x-bond-score/dist/bondscore-v1.5.9-production.zip';
  const zipBuffer = fs.readFileSync(zipPath);
  const uploadUrl = release.upload_url.replace('{?name,label}', `?name=bondscore-v1.5.9-production.zip`);

  console.log('Uploading asset bondscore-v1.5.9-production.zip (' + zipBuffer.length + ' bytes)...');
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node-Release-Uploader',
      'Content-Type': 'application/zip',
      'Content-Length': zipBuffer.length.toString()
    },
    body: zipBuffer
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error('Failed to upload asset:', uploadRes.status, errText);
    process.exit(1);
  }

  const asset = await uploadRes.json();
  console.log('Uploaded asset successfully:', asset.browser_download_url);
  console.log('Release published successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
