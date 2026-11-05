# One benign sequential-relaunch control

Ровно один root-approved control source558f00e5 выполнен10:02:19–10:02:44 UTC, private raw `/private/tmp/orbis-cutover-relaunch.t_5eise0`. Новый пустой profile, about:blank only, exact reviewed public persistent pipe/Chrome156/PW1.63/options, deny-egress. Никаких App/Auth/DB или P/N. Actual exit **1**, overall90s watchdog не сработал, remaining=[]. CPU/browser освобождены; новых запусков нет.

Первый launch PID23711/start17:02:20 local успешно подключился и ответил Browser.getVersion. Затем context.close прошёл штатно; closing event/исчезновение всех9 записанных identities подтверждены до второго launch. Перед повторным запуском того же profile все три Singleton markers отсутствовали, exit_type=Normal.

Второй launch PID23750 стартовал10:02:25.558 UTC. Pipe EOF записан10:02:27.296, Chrome process exit0 —10:02:28.972. Timeout cleanup `<gracefully close start>` появился лишь10:02:43.557 после18s deadline. **В этом контроле process exit предшествует timeout cleanup на14.585s**, а не является его следствием. Контекст второго launch не создан; scoped failed-startup cleanup и внешний monitor подтвердили исчезновение его identities.

Allocator warning и CVDisplayLink -6670 присутствуют и в первом успешном launch, и во втором неуспешном. Значит эти warnings сами по себе не объясняют отказ. Полные stderr обеих попыток, UTC/monotonic stage markers, PID/start census и Singleton snapshots сохранены. Pipe EOF/second-launch failure воспроизведён без данных/кода Orbis. Это устанавливает независимую от Orbis границу текущего sequential launcher environment; не устанавливает конкретный внутренний дефект Bun, Chrome или Playwright и не доказывает original P2 cause.

P2 остаётся startup-blocked: no current browser startup/recovery/replay/purge verdict. Faithful resume с потерянным fixture signer закрыт root; DB/профили/Authentification не менялись ради continuation. Одобренное действие завершено. Никаких third fullP/newDB/Node counterfactual без нового решения.

Public evidence `relaunch-control-evidence/SHA256SUMS` фиксирует sanitized копии; personal hostname из SingletonLock target заменён на `[host-redacted]`. Private originals остаются в directory700, raw/public byte hashes записаны без раскрытия hostname. Profile state не переносился в пользовательский Chrome. Все source558 bytes неизменны; product/постоянные документы не редактировались.
