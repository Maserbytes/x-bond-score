const fs = require('fs');
const path = 'C:/Users/win10/AppData/Local/Google/Chrome/User Data/Default/Local Extension Settings/doocegpmgdabnihecnehjihbhcoaolpc/000003.log';
if (!fs.existsSync(path)) {
  console.log('No 000003.log found');
  process.exit(0);
}
const str = fs.readFileSync(path, 'latin1');
const regex = /"handle":"([^"]+)".*?"avatarUrl":"([^"]*)"/g;
let m;
let count = 0;
while ((m = regex.exec(str)) !== null) {
  count++;
  console.log(`[${count}] Handle: @${m[1]} | Avatar: ${m[2] ? m[2].slice(0, 50) + '...' : '(EMPTY)'}`);
}
console.log('Total matches:', count);
