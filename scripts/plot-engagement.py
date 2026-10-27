import os
os.environ.setdefault('MPLCONFIGDIR','/tmp/rpg-engagement-mpl')
os.environ.setdefault('XDG_CACHE_HOME','/tmp/rpg-engagement-cache')
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(__file__).resolve().parents[1]
r=json.loads((root/'docs/engagement-results.json').read_text())
assert r['mode']=='live' and r.get('finished_at')
labels={'baseline':'Fixed world','narration-only':'Narration only','authored-expansion':'Authored expansion'}
colors=['#64748b','#d97706','#2563eb']
fig,axs=plt.subplots(2,2,figsize=(12,8),layout='constrained')
for s,col in zip(r['summary'],colors):
 arm=s['arm'];rows=[e for e in r['episodes'] if e['arm']==arm]
 xs=range(1,5)
 for ax,key in [(axs[0,0],'boredom_1_to_5'),(axs[0,1],'play_interest_1_to_5')]:
  ys=[]
  for n in xs:
   vals=[e['rating'][key] for e in rows if e['chapter']==n and e.get('rating') and isinstance(e['rating'].get(key),(int,float))]
   ys.append(sum(vals)/len(vals) if vals else float('nan'))
  ax.plot(xs,ys,'-o',color=col,label=labels[arm])
 axs[1,0].plot(xs,[sum(e['expansion']['locations'] for e in rows if e['chapter']==n)/2 for n in xs],'-o',color=col,label=labels[arm])
 idx=list(labels).index(arm)
 vals=[s['new_location_access']/8,s['new_npc_interactions']/8,s['recall_new_npc']/8,s['quest_flags']/8]
 axs[1,1].bar([i+(idx-1)*.25 for i in range(4)],vals,width=.25,color=col,label=labels[arm])
axs[0,0].set_title('Boredom (higher is worse)')
axs[0,1].set_title('Interest in continued actual play')
for ax in axs[0]:
 ax.set_ylim(.7,5.3);ax.set_yticks(range(1,6));ax.set_ylabel('Subjective model score, 1-5')
axs[1,0].set_title('Locations present in active release')
axs[1,0].set_ylabel('Locations (two personas averaged)')
axs[1,1].set_title('Executable expansion, persistence and quest effect')
axs[1,1].set_xticks(range(4),['New place\naccess','New NPC\ninteraction','Event memory\nrecall','Quest flag\nchange'],fontsize=9)
axs[1,1].set_ylim(0,1.2);axs[1,1].set_ylabel('Success fraction, 8 probes per arm')
for ax in [axs[0,0],axs[0,1],axs[1,0]]:
 ax.set_xticks(range(1,5));ax.set_xlabel('Chapter')
for ax in axs.flat:ax.grid(axis='y',alpha=.22)
axs[0,0].legend(fontsize=9)
fig.suptitle('Engagement and world expansion: matched 3-condition, 4-chapter evaluation\n2 persona judges; 288 scripted non-combat actions; scores are model opinions',fontsize=13)
fig.savefig(root/'docs/engagement-metrics.png',dpi=180)
fig.savefig(root/'docs/engagement-metrics.svg')
print('Saved engagement-metrics.png and .svg')
