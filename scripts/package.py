"""Package the portable external source using a public-file allowlist."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, hashlib
root=Path(__file__).resolve().parent.parent
manifest=json.loads((root/'plugin.json').read_text())
assert manifest['id']=='bilibili' and manifest['main']=='index.js'
assert manifest['version']==json.loads((root/'package.json').read_text())['version']
files=['plugin.json','index.js','locales/zh-CN.json','README.md','NOTICE.md','LICENSE']
with ZipFile(root/'plugin.zip','w',compression=ZIP_DEFLATED) as archive:
 for name in files:archive.write(root/name,name)
with ZipFile(root/'plugin.zip') as archive:
 assert archive.testzip() is None
 for name in archive.namelist():assert archive.read(name)==(root/name).read_bytes()
print('Packaged',manifest['version'],len(files),'public files')
print('SHA-256',hashlib.sha256((root/'plugin.zip').read_bytes()).hexdigest())
