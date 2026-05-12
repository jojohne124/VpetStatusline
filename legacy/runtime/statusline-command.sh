#!/usr/bin/env bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name // "Unknown Model"')
remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')

if [ -n "$remaining" ]; then
  printf "%s | Context: %.0f%% remaining" "$model" "$remaining"
else
  printf "%s | Context: --" "$model"
fi
