#!/usr/bin/env python3
"""
Claude Values generator - COMO 26/27 auction fair values.

Pulls live FPL bootstrap-static data and produces claude-values.json / .csv
with a retention-adjusted convex valuation for every player.

Usage:  python3 generate_claude_values.py
Deps:   requests  (pip install requests)

Re-run any time before the auction - prices, injuries and ownership move daily.
"""
import json, csv, requests

# ---------------- tunable knobs ----------------
GAMMA          = 1.4    # convexity: >1 gives premiums a super-linear share
                        # (reliability premium; linear pts/$ undervalues stars)
REPLACEMENT_RK = 124    # replacement level ~ just outside the 120 drafted slots
ROOM_MONEY     = 24000  # 8 managers x $3,000 August pots
RESERVE        = 1      # $1 floor per slot (rulebook reserve)
FEB_EFF_POT    = 2400   # effective Feb firepower: $2,000 injection + typical
                        # banked carry, net of waiver drain (one-wallet model)
RETAIN_CUTOFF  = 0.7    # retention option dead once price ~= 0.7 * FEB_EFF_POT
H1_FLOOR       = 0.52   # share of value that is the first-half "rental"
# ------------------------------------------------

AV = {'a': 1.0, 'd': 0.7, 'i': 0.25, 's': 0.85, 'u': 0.0}

def retention_mult(x):
    """Fraction of full-season value captured when bought at price x.
    H1 always earned; H2 (the retention option) decays as price approaches
    the point where retaining cripples the February rebuild."""
    return H1_FLOOR + (1 - H1_FLOOR) * max(0.0, 1.0 - x / (RETAIN_CUTOFF * FEB_EFF_POT))

def main():
    d = requests.get("https://fantasy.premierleague.com/api/bootstrap-static/",
                     headers={"User-Agent": "Mozilla/5.0"}).json()
    teams = {t['id']: t['short_name'] for t in d['teams']}
    pos = {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}

    players = []
    for e in d['elements']:
        price = e['now_cost'] / 10
        sel = float(e['selected_by_percent'])
        av = AV[e['status']]
        nailed = sel / (sel + 3.0)                    # saturating crowd signal
        S = price * (0.35 + 0.9 * nailed) * av        # reliability-weighted output
        players.append({
            'id': e['id'], 'name': e['web_name'],
            'full_name': f"{e['first_name']} {e['second_name']}",
            'team': teams[e['team']], 'pos': pos[e['element_type']],
            'fpl_price': price, 'selected_pct': sel,
            'status': e['status'], 'news': e['news'], 'S': S,
        })

    ranked = sorted(players, key=lambda x: -x['S'])
    R = ranked[REPLACEMENT_RK]['S']
    for p in players:
        p['VORP'] = max(0.0, p['S'] ** GAMMA - R ** GAMMA)   # value over replacement

    # iterate value <-> retention multiplier to a fixed point, renormalising
    for p in players:
        p['adj'] = p['VORP']
    for _ in range(30):
        top = sorted(players, key=lambda x: -x['adj'])[:120]
        scale = (ROOM_MONEY - 120 * RESERVE) / sum(p['adj'] for p in top)
        for p in players:
            p['adj'] = p['VORP'] * retention_mult(p['adj'] * scale)

    top = sorted(players, key=lambda x: -x['adj'])[:120]
    scale = (ROOM_MONEY - 120 * RESERVE) / sum(p['adj'] for p in top)
    for p in players:
        p['claude_value'] = round(RESERVE + p['adj'] * scale) if p['S'] > 0 else 0
        p['retainability'] = round(retention_mult(p['adj'] * scale), 2)
        for k in ('S', 'VORP', 'adj'):
            del p[k]

    players.sort(key=lambda x: (-x['claude_value'], -x['fpl_price'], -x['selected_pct']))
    with open('claude-values.json', 'w') as f:
        json.dump(players, f, indent=1)
    with open('claude-values.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=players[0].keys())
        w.writeheader(); w.writerows(players)
    print(f"wrote {len(players)} players | top-120 sum:",
          sum(p['claude_value'] for p in players[:120]))

if __name__ == '__main__':
    main()
