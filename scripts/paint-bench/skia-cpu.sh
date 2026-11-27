#!/bin/sh
# Prints the CPU seconds spent so far by the SkiaCPUWorker threads of the WebKit child
# processes of PID $1 (software rasterization of paint tiles).
for p in $(ps -o pid= --ppid "$1"); do
  for t in /proc/"$p"/task/*; do
    case $(cat "$t/comm" 2>/dev/null) in
      SkiaCPU*) awk '{ sub(/^.*\) /, ""); split($0, a, " "); print a[12] + a[13] }' "$t/stat" ;;
    esac
  done
done | awk -v hz="$(getconf CLK_TCK)" '{ s += $1 } END { printf "%.2f\n", s / hz }'
