#!/bin/bash
# 重新生成 manifest.json：列出当前目录下所有 ruleclassroom_*.json 存档文件，
# 供 rule_classroom_viewer.html 部署到 GitHub Pages / VPS 后自动加载。
# 新增月份文件后重新运行一次即可。
cd "$(dirname "$0")" || exit 1

files=(ruleclassroom_*.json)
if [ ! -e "${files[0]}" ]; then
  echo "没有找到 ruleclassroom_*.json 文件" >&2
  exit 1
fi

{
  printf '[\n'
  for i in "${!files[@]}"; do
    sep=$([ "$i" -eq $((${#files[@]} - 1)) ] && echo '' || echo ',')
    printf '  "%s"%s\n' "${files[$i]}" "$sep"
  done
  printf ']\n'
} > manifest.json

echo "manifest.json 已更新，共 ${#files[@]} 个文件"
