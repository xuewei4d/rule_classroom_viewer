#!/usr/bin/env python3
"""合并多个 ruleclassroom_*.json 存档文件，按 id 去重，再按月份重新拆分输出。

用法:
    python3 merge_dedup_by_month.py                # 预览：只打印统计信息，不写文件
    python3 merge_dedup_by_month.py --write         # 写入 merged_output/ 目录（不覆盖原文件）
    python3 merge_dedup_by_month.py --write --in-place   # 直接覆盖当前目录下的月份文件

去重规则：同一条记录（相同 id）如果在多个文件中出现，保留 updated_at 更新的版本。
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import date, timedelta

PATTERN = re.compile(r'^(.+?)_\d{4}-\d{2}(?:_\S+)?\.json$')


def find_prefix(files):
    for fn in files:
        m = PATTERN.match(os.path.basename(fn))
        if m:
            return m.group(1)
    return 'ruleclassroom'


def load_records(files):
    records = []
    for fn in files:
        with open(fn, encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, list):
            print(f'警告：{fn} 顶层不是数组，已跳过', file=sys.stderr)
            continue
        records.extend(data)
    return records


def dedup(records):
    by_id = {}
    for rec in records:
        rid = rec.get('id')
        if rid is None:
            # 没有 id 的记录直接保留（用自身内容当 key，避免误删）
            rid = json.dumps(rec, sort_keys=True, ensure_ascii=False)
        existing = by_id.get(rid)
        if existing is None:
            by_id[rid] = rec
            continue
        # 保留 updated_at 更新的版本（ISO8601 字符串可直接比较）
        if (rec.get('updated_at') or '') >= (existing.get('updated_at') or ''):
            by_id[rid] = rec
    return list(by_id.values())


def group_by_month(records):
    months = {}
    no_date = []
    for rec in records:
        created = rec.get('created_at')
        if not created or len(created) < 7:
            no_date.append(rec)
            continue
        key = created[:7]  # 'YYYY-MM'
        months.setdefault(key, []).append(rec)
    for recs in months.values():
        recs.sort(key=lambda r: r.get('created_at', ''))
    return months, no_date


def find_missing_days(records):
    """返回 (缺失日期列表, 最早日期, 最晚日期)。缺失指该日期区间内一条记录都没有。"""
    days_with_data = set()
    for rec in records:
        created = rec.get('created_at')
        if created and len(created) >= 10:
            days_with_data.add(created[:10])
    if not days_with_data:
        return [], None, None
    start = date.fromisoformat(min(days_with_data))
    end = date.fromisoformat(max(days_with_data))
    missing = []
    d = start
    while d <= end:
        iso = d.isoformat()
        if iso not in days_with_data:
            missing.append(iso)
        d += timedelta(days=1)
    return missing, start, end


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--glob', default='ruleclassroom_*.json', help='输入文件匹配模式')
    ap.add_argument('--write', action='store_true', help='实际写出文件（默认只预览统计）')
    ap.add_argument('--in-place', action='store_true', help='直接覆盖当前目录同名月份文件（默认写到 merged_output/）')
    ap.add_argument('--out-dir', default='merged_output', help='非 in-place 模式下的输出目录')
    ap.add_argument('--no-missing-days', action='store_true', help='跳过缺失日期检查')
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    files = sorted(glob.glob(args.glob))
    files = [f for f in files if os.path.basename(f) != 'manifest.json']
    if not files:
        print('没有找到匹配的输入文件', file=sys.stderr)
        sys.exit(1)

    prefix = find_prefix(files)
    print(f'输入文件 ({len(files)} 个):')
    for f in files:
        print(f'  {f}')

    records = load_records(files)
    print(f'\n合并前总记录数: {len(records)}')

    deduped = dedup(records)
    print(f'去重后记录数: {len(deduped)} (移除 {len(records) - len(deduped)} 条重复)')

    months, no_date = group_by_month(deduped)
    if no_date:
        print(f'警告: {len(no_date)} 条记录缺少 created_at，已忽略', file=sys.stderr)

    print('\n按月份拆分结果:')
    for key in sorted(months):
        print(f'  {key}: {len(months[key])} 条')

    if not args.no_missing_days:
        missing, start, end = find_missing_days(deduped)
        if start is None:
            print('\n无法检查缺失日期（记录都没有有效 created_at）')
        else:
            print(f'\n日期范围: {start} ~ {end}')
            if missing:
                print(f'缺失日期 ({len(missing)} 天，区间内完全没有记录):')
                for d in missing:
                    print(f'  {d}')
            else:
                print('缺失日期: 无，区间内每天都有记录')

    if not args.write:
        print('\n(预览模式，未写入文件；加 --write 实际写出)')
        return

    out_dir = script_dir if args.in_place else os.path.join(script_dir, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    written = []
    for key in sorted(months):
        out_path = os.path.join(out_dir, f'{prefix}_{key}.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(months[key], f, ensure_ascii=False, indent=2)
        written.append(out_path)
        print(f'已写出 {out_path}')

    if args.in_place:
        # 清理不再需要的旧分片文件（例如 *_0001.json / *_2304.json），
        # 避免 manifest 里同时存在旧分片和新的合并月份文件
        written_basenames = {os.path.basename(p) for p in written}
        for f in files:
            if os.path.basename(f) not in written_basenames:
                os.remove(f)
                print(f'已删除旧分片文件 {f}')
        print('\n完成。建议接下来运行 ./update-manifest.sh 重新生成 manifest.json')
    else:
        print(f'\n完成，文件已写入 {out_dir}/（原文件未改动）')


if __name__ == '__main__':
    main()
