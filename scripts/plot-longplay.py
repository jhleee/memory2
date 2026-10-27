"""Create standalone plots from a completed multi-session evaluation (no network)."""
import json
from pathlib import Path
import os
os.environ.setdefault('MPLCONFIGDIR','/tmp/rpg-longplay-mpl')
os.environ.setdefault('XDG_CACHE_HOME','/tmp/rpg-longplay-cache')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root=Path(__file__).resolve().parents[1]
r=json.loads((root/'docs/longplay-results.json').read_text())
if 'summary' not in r:
    raise SystemExit('Completed report required')
fig, axes=plt.subplots(2,3,figsize=(14,8.5),layout='constrained')
colors=['#2563eb','#ea580c']
for c,color in zip(r['campaigns'],colors):
    rows=c['sessions']; xs=[s['session'] for s in rows]; label=c['persona']
    axes[0,0].plot(xs,[s['end_state']['enemy_hp'] for s in rows],'-o',color=color,label=label)
    axes[0,1].plot(xs,[100*s['meaningful_changes']/max(1,s['committed']) for s in rows],'-o',color=color,label=label)
    axes[0,2].plot(xs,[s['action_entropy_bits'] for s in rows],'-o',color=color,label=label)
    scores=[(s.get('assessment') or {}).get('scores',{}).get('interest_next_session') for s in rows]
    axes[1,0].plot(xs,[float(v) if v is not None else float('nan') for v in scores],'-o',color=color,label=label)
    axes[1,2].plot(xs,[s['latency']['p95_ms'] for s in rows],'-o',color=color,label=label)
methods=['exact','verbatim','paraphrase','paraphrase_decision']
for j,(s,color) in enumerate(zip(r['summary'],colors)):
    values=[s[m]['hits']/s[m]['n'] if s[m]['n'] else 0 for m in methods]
    bars=axes[1,1].bar([i+(j-.5)*.36 for i in range(4)],values,width=.36,color=color,label=s['persona'])
    for bar,m in zip(bars,methods):
        axes[1,1].text(bar.get_x()+bar.get_width()/2,bar.get_height()+.025,f"{s[m]['hits']}/{s[m]['n']}",ha='center',fontsize=8)
axes[1,1].set_xticks(range(4),['Exact marker','Original text','Paraphrase','Paraphrase\n+ decision'],fontsize=9)
axes[1,1].set_ylim(0,1.17)
axes[1,1].set_ylabel('Evidence-backed recall hit rate')
titles=['Enemy HP at session end','Resource / goal change rate','Action-type entropy','Model interest in another session','Two-session-old memory recall','Action latency (MCP round trip)']
ylabels=['HP','% of committed actions','bits','Subjective score (1-5)',None,'p95 milliseconds']
for ax,title,ylabel in zip(axes.flat,titles,ylabels):
    ax.set_title(title,fontsize=11)
    if ylabel: ax.set_ylabel(ylabel)
    if ax is not axes[1,1]:
        ax.set_xlabel('Session')
        ax.set_xticks(range(1,r['design']['sessions_per_campaign']+1))
    ax.grid(axis='y',alpha=.22)
axes[1,0].set_ylim(.7,5.3)
axes[0,0].legend(fontsize=8)
fig.suptitle(f"Long-play evaluation: {sum(s['committed'] for s in r['summary'])} committed actions, {sum(s['sessions'] for s in r['summary'])} sessions\nSession policies selected by Flint; actions executed by a scripted legal-action adapter",fontsize=13)
fig.savefig(root/'docs/longplay-metrics.png',dpi=180)
fig.savefig(root/'docs/longplay-metrics.svg')
with (root/'docs/longplay-sessions.tsv').open('w') as f:
    f.write('persona\tsession\tcommitted\tenemy_hp\tpotions\tresource_goal_changes\tadapter_substitutions\taction_entropy\tinterest_next_session\tp95_ms\n')
    for c in r['campaigns']:
        for s in c['sessions']:
            interest=(s.get('assessment') or {}).get('scores',{}).get('interest_next_session','')
            f.write('\t'.join(map(str,[c['persona'],s['session'],s['committed'],s['end_state']['enemy_hp'],s['end_state']['potions'],s['meaningful_changes'],s['adapter_substitutions'],s['action_entropy_bits'],interest,s['latency']['p95_ms']]))+'\n')
print('Saved docs/longplay-metrics.png, .svg, longplay-sessions.tsv')
