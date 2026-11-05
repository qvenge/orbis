from pathlib import Path
from collections import Counter
import difflib
p=Path('/private/tmp/orbis-b-restore.oE4t8P/log')
source=(p/'source-catalog.log').read_text().splitlines()
target=(p/'target-catalog-repaired.log').read_text().splitlines()
diff='\n'.join(difflib.unified_diff(source,target,fromfile='source-catalog',tofile='target-catalog-repaired',lineterm=''))+'\n'
(p/'source-target-repaired-catalog.diff').write_text(diff)
assert source[0].endswith('|7704502930497941539')
assert target[0].endswith('|7704502933634711586')
assert source[-1].isdigit() and target[-1].isdigit() and source[-1]!=target[-1]
retained_admin_edge='supabase_admin|orbis_change_feed_owner|supabase_admin|f|f|f'
normalized_source=source[1:-1]
normalized_target=target[1:-1]
assert normalized_source.count(retained_admin_edge)==1
assert retained_admin_edge not in normalized_target
normalized_source.remove(retained_admin_edge)
assert normalized_source==normalized_target, (Counter(normalized_source)-Counter(normalized_target), Counter(normalized_target)-Counter(normalized_source))
assert source[-3:-1]==target[-3:-1]==['5250','84|1131|5252']
print(f'Exact normalized catalog match ({len(normalized_target)} lines); only distinct cluster id, xmin, and intentionally omitted non-effective admin membership.')
