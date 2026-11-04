#!/bin/zsh
scratch=${0:A:h}
archive=$(cat "$scratch/b13-web-final-fixture-run.path")
cd "$archive/apps/web" || exit 1
paths=(
  src/features/apps/open.test.tsx
  src/features/apps/nav-editor.test.tsx
  src/features/budget/EnvelopeCard.test.tsx
  src/features/budget/plan-owner.test.tsx
  src/features/page/menu.test.tsx
  src/features/settings/apps-and-extensions.test.tsx
)
names='I-1: домашняя /a/<(выключенное|архивное)>|I-1: плитка выключенного приложения|отказ «включить»|shared record menu item|страница в хосте: «Добавить в навигацию»|«Новое приложение…» \(«Мой дом»|отказ пачки|I-1: правка «Состава»|правка графа гасит|новая запись поставки|одна пачка с аспектом «страница»; тост «Отменить»|жест меню при неотправленной правке тела|B13 old body cannot enter a view rewrite|Task20 populated histories actual page menu|budget refresh continuation|тап по карточке открывает запись категории'
bun x --no-install vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile="$scratch/b13-web-final-fixtures-test.json" "${paths[@]}" -t "$names" > "$scratch/b13-web-final-fixtures-test.log" 2>&1
echo "$?" > "$scratch/b13-web-final-fixtures-test.exit"
bun run typecheck > "$scratch/b13-web-final-fixtures-type.log" 2>&1
echo "$?" > "$scratch/b13-web-final-fixtures-type.exit"
cd "$archive" || exit 1
files=("${paths[@]/#/apps/web/}")
node_modules/.bin/biome check "${files[@]}" > "$scratch/b13-web-final-fixtures-biome.log" 2>&1
echo "$?" > "$scratch/b13-web-final-fixtures-biome.exit"
tail -15 "$scratch/b13-web-final-fixtures-test.log"
cat "$scratch"/b13-web-final-fixtures-{test,type,biome}.exit
