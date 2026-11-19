const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = 'D:/x-bond-score';
const targets = [
  'C:/Users/win10/Downloads/bondscore-v1.5.9-production (1)',
  'D:/bondscore-v1.4.1-from-github'
];

const items = ['manifest.json', 'background.js', 'content', 'core', 'icons', 'popup'];

for (const target of targets) {
  if (!fs.existsSync(target)) {
    console.log(`Target does not exist: ${target}`);
    continue;
  }
  console.log(`Syncing to ${target}...`);
  for (const item of items) {
    const src = path.join(rootDir, item);
    const dest = path.join(target, item);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
  console.log(`Synced to ${target} successfully.`);
}

// Rebuild zip
console.log('Rebuilding zip packages...');
execSync('node scripts/build-zip.cjs', { cwd: rootDir, stdio: 'inherit' });

// Copy zip to Downloads
const srcZip = path.join(rootDir, 'dist/bondscore-v1.5.9-production.zip');
const destZip = 'C:/Users/win10/Downloads/bondscore-v1.5.9-production.zip';
if (fs.existsSync(srcZip)) {
  fs.copyFileSync(srcZip, destZip);
  console.log(`Copied updated zip to ${destZip} (${fs.statSync(destZip).size} bytes)`);
}
