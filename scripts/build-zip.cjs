const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = 'D:/x-bond-score';
const stagingDir = path.join(rootDir, 'dist/staging');
const distDir = path.join(rootDir, 'dist');

if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

const items = ['manifest.json', 'background.js', 'content', 'core', 'icons', 'popup'];

for (const item of items) {
  const src = path.join(rootDir, item);
  const dest = path.join(stagingDir, item);
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('Staged files successfully.');

const zipV159 = path.join(distDir, 'bondscore-v1.5.9-production.zip');
const zipProd = path.join(distDir, 'bondscore-production.zip');

if (fs.existsSync(zipV159)) fs.unlinkSync(zipV159);
if (fs.existsSync(zipProd)) fs.unlinkSync(zipProd);

// Use powershell Compress-Archive
const psCmd = `powershell -NoProfile -Command "Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipV159}' -Force"`;
execSync(psCmd, { stdio: 'inherit' });
fs.copyFileSync(zipV159, zipProd);

console.log('Created:', zipV159, 'Size:', fs.statSync(zipV159).size);
console.log('Created:', zipProd, 'Size:', fs.statSync(zipProd).size);
