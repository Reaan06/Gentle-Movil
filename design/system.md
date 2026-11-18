# Gentle Movil — Design System

Sincronizado de las fuentes del proyecto (2026-11-17). Sistema propuesto a partir
de `ui/src/app.css` — es el único sistema existente; el proyecto no tenía
`design/system.md` antes de este archivo.

## Colores — tema oscuro (por defecto)

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#060407` | fondo raíz |
| `--bg-sunken` | `#0a060c` | fondo hundido (barras, huecos) |
| `--surface` | `#100A0F` | tarjetas, paneles |
| `--border` | `#563040` | bordes sutiles |
| `--border-strong` | `#7a4558` | bordes enfatizados |
| `--text` | `#F6EFF3` | texto principal |
| `--accent` | `#F095C8` | acento rosa (CTA, foco, marca) |
| `--accent-hover` | `#FFB1DD` | hover del acento |
| `--accent-ink` | `#28121E` | texto sobre acento |
| `--accent-text` | `#FFB1DD` | texto/enlaces acentuados |
| `--deep-pink` | `#C96AA2` | rosa profundo (secundario) |
| `--warning` | `#F2B86D` | avisos |
| `--ok` | `#4fc58c` | éxito |
| `--danger` | `#FF718F` | error/destructivo |
| `--code-bg` | `#0f0c12` | bloques de código, terminal |
| `--overlay` | `rgb(0 0 0 / 0.55)` | fondos modales |
| `--accent-soft` | `rgb(240 149 200 / 0.12)` | relleno suave de acento |
| `--glow` | `0 10px 30px #f095c84d` | resplandor de CTA/marca |

## Colores — tema claro

| Token | Valor |
|---|---|
| `--bg` | `#f8f5f7` |
| `--bg-sunken` | `#f0eae0` |
| `--surface` | `#ffffff` |
| `--border` | `#e0d3dc` |
| `--border-strong` | `#c9b0c0` |
| `--text` | `#1a161a` |

## Tipografía

| Token | Valor | Uso |
|---|---|---|
| `--mono` | `"IosevkaTerm NF", "Iosevka Term", "JetBrains Mono", ui-monospace, ...` | identidad: todo el producto es mono |
| escala de texto | `0.7 · 0.75 · 0.8 · 0.9 · 0.95 · 1.05rem` | jerarquía compacta tipo terminal |

## Forma y profundidad

| Token | Valor |
|---|---|
| `--radius-sm` | `8px` |
| `--radius-md` / `--radius` | `12px` |
| `--radius-lg` | `16px` |
| `--radius-bento` | `20px` (tarjetas grandes) |
| `--radius-pill` | `999px` (chips, badges) |
| `--shadow` | `0 1px 0 rgb(255 255 255 / 0.03) inset, 0 18px 40px -18px rgb(0 0 0 / 0.6)` |

## Reglas de componentes (observadas en el código existente)

- Tarjetas `bento`: `--surface` + `--radius-bento` + `--border`.
- CTA primario: relleno `--accent`, texto `--accent-ink`, `--radius-pill`, `--glow` al hover.
- Chips/estados: píldora con `--accent-soft` y texto `--accent-text`.
- Fondo decorativo: campo de puntos (`--dot-color`) y retícula (`--grid-line`) muy sutiles.
- Identidad de marca: logotipo π en dorado/rosa, tipografía mono, estilo "terminal elegante".
