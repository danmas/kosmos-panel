 Describing process with id 2 - name kosmos-panel 
┌───────────────────┬───────────────────────────────────────────────────┐
│ status            │ online                                            │
│ name              │ kosmos-panel                                      │
│ namespace         │ default                                           │
│ version           │ 0.1.0                                             │
│ restarts          │ 23                                                │
│ uptime            │ 7m                                                │
│ script path       │ C:\ERV\projects-ex\kosmos-panel\server\index.js   │
│ script args       │ N/A                                               │
│ error log path    │ C:\Users\roman\.pm2\logs\kosmos-panel-error-2.log │
│ out log path      │ C:\Users\roman\.pm2\logs\kosmos-panel-out-2.log   │
│ pid path          │ C:\Users\roman\.pm2\pids\kosmos-panel-2.pid       │
│ interpreter       │ node                                              │
│ interpreter args  │ N/A                                               │
│ script id         │ 2                                                 │
│ exec cwd          │ C:\ERV\projects-ex\kosmos-panel                   │
│ exec mode         │ cluster_mode                                      │
│ node.js version   │ 20.19.5                                           │
│ node env          │ development                                       │
│ watch & reload    │ ✘                                                 │
│ unstable restarts │ 0                                                 │
│ created at        │ 2026-01-18T08:00:22.449Z                          │
└───────────────────┴───────────────────────────────────────────────────┘
 Actions available 
┌────────────────────────┐
│ km:heapdump            │
│ km:cpu:profiling:start │
│ km:cpu:profiling:stop  │
│ km:heap:sampling:start │
│ km:heap:sampling:stop  │
└────────────────────────┘
 Trigger via: pm2 trigger kosmos-panel <action_name>

 Code metrics value 
┌────────────────────────┬─────────────┐
│ Used Heap Size         │ 22.05 MiB   │
│ Heap Usage             │ 86.88 %     │
│ Heap Size              │ 25.38 MiB   │
│ Event Loop Latency p95 │ 13.79 ms    │
│ Event Loop Latency     │ 6.04 ms     │
│ Active handles         │ 32          │
│ Active requests        │ 16          │
│ HTTP                   │ 0.2 req/min │
│ HTTP P95 Latency       │ 1.75 ms     │
│ HTTP Mean Latency      │ 1 ms        │
└────────────────────────┴─────────────┘
 Divergent env variables from local env 
┌─────────────────┬───────────────────┐
│ ANSICON         │ 136x1000 (136x24) │
│ ConEmuBackHWND  │ 0x000F0AEE        │
│ ConEmuDrawHWND  │ 0x00350AFA        │
│ ConEmuServerPID │ 17792             │
└─────────────────┴───────────────────┘

 Add your own code metrics: http://bit.ly/code-metrics
 Use `pm2 logs kosmos-panel [--lines 1000]` to display logs
 Use `pm2 env 2` to display environment variables
 Use `pm2 monit` to monitor CPU and Memory usage kosmos-panel
