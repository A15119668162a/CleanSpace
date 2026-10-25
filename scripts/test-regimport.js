/** 验证 UTF-16LE .reg import 是否工作 */
const { writeFileSync } = require('fs')
const { execSync } = require('child_process')
const path = require('path')

const content = 'Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]\r\n"CsImportTest"="C:\\\\test\\\\x.exe"\r\n'
writeFileSync(path.join(__dirname, '..', 'test.reg'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]))
console.log('reg file written (utf16le+bom)')

try {
  execSync(`reg import "${path.join(__dirname, '..', 'test.reg')}"`, { windowsHide: true, timeout: 10000 })
  console.log('IMPORT: OK')
  const q = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v CsImportTest', { windowsHide: true, timeout: 10000 }).toString()
  console.log('QUERY:', q.includes('CsImportTest') ? 'FOUND' : 'NOT FOUND')
  execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v CsImportTest /f', { windowsHide: true })
  console.log('CLEANED')
} catch (e) {
  console.log('FAIL:', e.message.split('\n')[0])
}
