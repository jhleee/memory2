import os
os.environ.setdefault('MPLCONFIGDIR','/tmp/rpg-campaign-v2-mpl')
os.environ.setdefault('XDG_CACHE_HOME','/tmp/rpg-campaign-v2-cache')
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(__file__).resolve().parents[1]
r=json.loads((root/'docs/campaign-v2-results.json').read_text())
assert r['mode']=='live' and r.get('finished_at')
fig,axs=plt.subplots(1,3,figsize=(14,4.5),layout='constrained')
for condition,color in [('narration-only','#64748b'),('campaign-overlay','#2563eb')]:
 rows=[s for s in r['sessions'] if s['condition']==condition]
 for ax,key,title in [(axs[0],'boredom_1_to_5','Boredom (higher is worse)'),(axs[1],'play_interest_1_to_5','Interest in continued play')]:
  ys=[]
  for n in range(1,5):
   vals=[s['rating'][key] for s in rows if s['session']==n and s.get('rating') and isinstance(s['rating'].get(key),(int,float))]
   ys.append(sum(vals)/len(vals) if vals else float('nan'))
  ax.plot(range(1,5),ys,'-o',label=condition,color=color);ax.set_title(title);ax.set_ylim(.7,5.3);ax.set_ylabel('Model opinion, 1-5')
 ys=[sum(s['audit']['completed_threads'] for s in rows if s['session']==n)/2 for n in range(1,5)]
 axs[2].plot(range(1,5),ys,'-o',label=condition,color=color)
axs[2].set_title('Completed story threads per campaign');axs[2].set_ylabel('Persisted completed threads')
for ax in axs:ax.set_xticks(range(1,5));ax.set_xlabel('Session');ax.grid(axis='y',alpha=.22)
axs[0].legend(fontsize=8)
fig.suptitle('Campaign overlay feedback test: 16 sessions, 192 scripted actions\nSame Game and pinned Release; combined new content + actual choice-effect intervention',fontsize=12)
fig.savefig(root/'docs/campaign-v2-metrics.png',dpi=180);fig.savefig(root/'docs/campaign-v2-metrics.svg')
print('Saved campaign-v2-metrics.png and .svg')
