from pathlib import Path
root=Path(__file__).parent
t=(root/'index.template.html').read_text(encoding='utf-8')
core=(root/'game_core.js').read_text(encoding='utf-8')
app=(root/'app.js').read_text(encoding='utf-8')
(root/'index.html').write_text(t.replace('/*__CORE__*/',core).replace('/*__APP__*/',app),encoding='utf-8')
print('built standalone index.html')
