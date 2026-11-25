import { buildAddress, parseAddress } from '@orbis/shared/nav';
import { createContext, lazy, Suspense, useContext, useMemo } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { RecordLink } from '../entity-ref/RecordLink';
import { recordIdOfLink } from '../entity-ref/record-link-controller';

const FileContent = lazy(() =>
  import('../files/FileContent').then((m) => ({ default: m.FileContent })),
);
export const FileMarkdownContext = createContext<ReadonlyMap<string, string> | null>(null);
const fileId = (url?: string) =>
  url?.match(/^orbis-file:([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/i)?.[1]?.toLowerCase();
const fileSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'orbis-file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'orbis-file'],
  },
};

/**
 * Ссылка на сущность в тексте. Класс символов и регистронезависимость — КОПИЯ серверного
 * `BODY_REFS_RE` (apps/server/src/executor/normalize.ts): что сервер посчитал ссылкой и завёл
 * в `body_refs` (backlinks), то и обязано стать кликабельным, иначе рендер и граф разъедутся.
 *
 * Регэксп бежит по сырому тексту, в том числе внутри блоков кода, — ровно как серверный
 * `extractBodyRefs`. Расхождение тут было бы хуже одинаковой наивности: показать ссылкой то,
 * чего нет в backlinks (или наоборот), — соврать про связи записи.
 */
const ENTITY_REF_RE = /\[\[entity:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/gi;

/**
 * Подпись уезжает в текст markdown-ссылки `[текст](путь)`. Собственные скобки и обратные
 * слэши подписи обязаны стать литералами: хвостовой `\` съел бы закрывающую скобку ссылки,
 * а перевод строки разорвал бы её на два абзаца — в обоих случаях ссылка распалась бы в текст.
 */
function escapeLinkText(label: string): string {
  return label.replace(/\s+/g, ' ').replace(/[\\[\]]/g, '\\$&');
}

/**
 * `[[entity:<uuid>]]` / `[[entity:<uuid>|подпись]]` → обычная markdown-ссылка ДО парсера:
 * дальше ссылка живёт общим путём (санитизация, стили, перехват клика), своей ветки рендера
 * ей не нужно.
 */
function linkifyEntityRefs(source: string): string {
  return source.replace(ENTITY_REF_RE, (whole, rawId: string, label?: string) => {
    const id = rawId.toLowerCase();
    // Запись в хосте (срез 1б §7.1): приложение ссылки решает рамка при нажатии (§7.2, §7.4).
    const href = buildAddress({ kind: 'record', app: { kind: 'host' }, id });
    // Форму id проверяет ТОТ ЖЕ разбор адреса, что разбирает клик (@orbis/shared/nav):
    // второй таблицы адресов и второго UUID-регэкспа у markdown быть не должно.
    // Не разобралось — не ссылка: печатаем как было, догадка тут хуже отказа.
    if (parseAddress(href) === null) return whole;
    const text = label?.trim() ? escapeLinkText(label.trim()) : id;
    return `[${text}](${href})`;
  });
}

function buildComponents(
  files: ReadonlyMap<string, string> | null,
  onEntityLink?: (id: string) => void,
): Components {
  return {
    a({ node: _node, href, children, ...rest }) {
      const target = files?.get(fileId(href) ?? '');
      if (target)
        return (
          <Suspense fallback={children}>
            <FileContent id={target} label={typeof children === 'string' ? children : undefined} />
          </Suspense>
        );
      const id = href && recordIdOfLink(href, document);
      // Исходный href нужен браузеру для новой вкладки. Рамку обычного клика
      // выбирает контроллер ссылки или переданное правило открытия.
      if (id) {
        return (
          <RecordLink
            {...rest}
            id={id}
            href={href}
            prose
            onOpen={onEntityLink ? (id, proceed) => proceed(() => onEntityLink(id)) : undefined}
          >
            {children}
          </RecordLink>
        );
      }
      // Остальные пути приложения загружаются браузером как прямой вход.
      // Протокол-относительный адрес записи уже распознан выше; остальные //host ссылки открываются отдельно.
      // Санитайзер её пропускает (двоеточия до первого «/» нет — значение считается
      // относительным), и без этой оговорки она увела бы SPA целиком, в той же вкладке,
      // с полным Referer. Разметку сюда приносит ответ модели — вектор не теоретический.
      if (href?.startsWith('/') && !href.startsWith('//')) {
        return (
          <a {...rest} href={href}>
            {children}
          </a>
        );
      }
      return (
        <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    // Единственная обёртка, которую не выразить стилем: широкая таблица обязана скроллиться
    // внутри себя, а не растягивать пузырь сообщения.
    img({ node: _node, src, alt, ...rest }) {
      const target = typeof src === 'string' && files?.get(fileId(src) ?? '');
      if (target)
        return (
          <Suspense fallback={alt}>
            <FileContent id={target} image label={alt} />
          </Suspense>
        );
      return <img {...rest} src={src || undefined} alt={alt ?? ''} />;
    },
    table({ node: _node, children, ...rest }) {
      return (
        <div className="my-2 overflow-x-auto">
          <table {...rest}>{children}</table>
        </div>
      );
    },
  };
}

const REMARK_PLUGINS = [remarkGfm];
// Эшелон обороны: сырой HTML react-markdown и так не парсит (rehype-raw не подключён),
// но схема по умолчанию снимает ещё и опасные протоколы ссылок (javascript:) целиком —
// и останется на месте, если кто-то когда-нибудь включит raw.
const REHYPE_PLUGINS = [rehypeSanitize];

/**
 * Markdown-текст без `dangerouslySetInnerHTML`: ответы модели в ленте чата и текст,
 * который пишет человек. Стили — блок `.orbis-markdown` в styles/globals.css.
 *
 * `{{query:…}}`-блоки здесь НЕ разбираются: в ленте они остаются текстом, виджеты живут
 * на detail-экране записи.
 */
export function Markdown({
  source,
  onEntityLink,
  className,
}: {
  source: string;
  /** Правило открытия записи для вызывающих с особой рамкой. По умолчанию берётся контекст. */
  onEntityLink?: (id: string) => void;
  className?: string;
}) {
  const text = useMemo(() => linkifyEntityRefs(source), [source]);
  const files = useContext(FileMarkdownContext);
  const components = useMemo(() => buildComponents(files, onEntityLink), [files, onEntityLink]);
  return (
    <div className={className ? `orbis-markdown ${className}` : 'orbis-markdown'}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={files ? [[rehypeSanitize, fileSchema]] : REHYPE_PLUGINS}
        urlTransform={(url) => (files?.has(fileId(url) ?? '') ? url : defaultUrlTransform(url))}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
