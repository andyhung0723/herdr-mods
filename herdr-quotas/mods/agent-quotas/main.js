// Agent Quotas mod for Herdr
// Dual-mode: Compact Sidebar Widget or Detailed Popup Dialog for Claude Code and Codex.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  theme, props, closeOverlay, openOverlay,
  setShared, shared
} from "herdr";
import { collectAllQuotas } from "./collector.js";

const OVERLAY_KEY = "agent-quotas.open-overlay";

function getBarColor(t, percent) {
  if (percent >= 90) return t.ansi1; // red / warning
  if (percent >= 70) return t.blocked || "#e3814f"; // yellow / warning
  return t.ansi2; // green / normal
}

export default class AgentQuotas extends View {
  init(initialProps, cx) {
    const p = initialProps ?? props() ?? {};
    this.overlayId = p.overlay ?? null;
    this.role = p.role ?? (this.overlayId ? "dialog" : "dialog");
    this.data = null;
    this.loading = true;
    this.error = null;

    this.handle = cx.focus_handle();
    if (this.role === "dialog") {
      this.handle.focus();
    }

    this.refresh(cx);

    // Auto refresh every 20 seconds
    cx.timer.every(20000, (cx) => {
      this.refresh(cx);
    });
  }

  refresh(cx) {
    this.loading = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const result = await collectAllQuotas();
        this.data = result;
        this.error = null;
      } catch (err) {
        this.error = String(err);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  openDetailedDialog() {
    if (this.overlayId) return;
    const existing = shared(OVERLAY_KEY);
    if (existing) {
      closeOverlay(existing);
    }
    const id = openOverlay({
      mod: "agent-quotas",
      props: { role: "dialog" },
    });
    setShared(OVERLAY_KEY, id);
  }

  close() {
    if (this.overlayId) {
      closeOverlay(this.overlayId);
      setShared(OVERLAY_KEY, null);
    }
  }

  // --- Render Compact Widget (Sidebar) ---
  renderWidget(t, cx) {
    const claude = this.data?.claude;
    const codex = this.data?.codex;

    const claudePercent = claude?.primaryPercent ?? 0;
    const claudeColor = getBarColor(t, claudePercent);

    const codexPercent = codex?.primaryPercent ?? 0;
    const codexColor = getBarColor(t, codexPercent);

    return v_flex()
      .id("agent-quotas-widget")
      .size_full()
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_click(() => this.openDetailedDialog())
      // Widget Header
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(image("custom-icons/claude.svg").w(14).h(14).flex_none())
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("Agent Quotas"))
          )
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child(this.loading ? "Updating…" : "Details ↗")
          )
      )
      // Row 1: Claude Code
      .child(
        v_flex()
          .gap(2)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(image("custom-icons/claude.svg").w(12).h(12).flex_none())
                  .child(div().text_size(11).font_medium().text_color(t.foreground).child("Claude Code"))
              )
              .child(
                div()
                  .text_size(10.5)
                  .font_medium()
                  .text_color(claudeColor)
                  .child(
                    claude?.hasCredit
                      ? `Credit: ${claude.credit.used} (${claude.credit.percent}%)`
                      : claude?.available
                      ? `Week: ${claude.week.percent}%`
                      : "Offline"
                  )
              )
          )
          // Progress bar track
          .child(
            h_flex()
              .h(4)
              .w_full()
              .rounded(2)
              .bg(t.background)
              .overflow_hidden()
              .child(
                div()
                  .h_full()
                  .w(`${Math.max(2, Math.min(100, claudePercent))}%`)
                  .bg(claudeColor)
                  .rounded(2)
              )
          )
      )
      // Row 2: Codex
      .child(
        v_flex()
          .gap(2)
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(image("custom-icons/codex.svg").w(12).h(12).flex_none())
                  .child(div().text_size(11).font_medium().text_color(t.foreground).child(`Codex (${codex?.plan || "PROLITE"})`))
              )
              .child(
                div()
                  .text_size(10.5)
                  .font_medium()
                  .text_color(codex?.hasWeek ? codexColor : t.muted)
                  .child(
                    codex?.hasWeek
                      ? `Week: ${codex.week.percent}%`
                      : codex?.formattedTokens
                      ? `${codex.formattedTokens} tok`
                      : "-"
                  )
              )
          )
          // Progress bar track if hasWeek
          .when(Boolean(codex?.hasWeek), (el) =>
            el.child(
              h_flex()
                .h(4)
                .w_full()
                .rounded(2)
                .bg(t.background)
                .overflow_hidden()
                .child(
                  div()
                    .h_full()
                    .w(`${Math.max(2, Math.min(100, codexPercent))}%`)
                    .bg(codexColor)
                    .rounded(2)
                )
            )
          )
      );
  }

  // --- Render Full Dialog (Popup / Overlay) ---
  renderDialog(t, cx) {
    const claude = this.data?.claude;
    const codex = this.data?.codex;

    const sevenDayPercent = claude?.week?.percent ?? 0;
    const sevenDayColor = getBarColor(t, sevenDayPercent);

    return v_flex()
      .id("agent-quotas-dialog")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .rounded(12)
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.overlayId) {
          this.close();
          cx.stop_propagation();
        }
      })
      // Header
      .child(
        h_flex()
          .h(46)
          .flex_none()
          .px(16)
          .gap(8)
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(image("custom-icons/claude.svg").w(20).h(20).flex_none())
          .child(
            div()
              .font_semibold()
              .text_size(14)
              .text_color(t.foreground)
              .child("Coding Agent Quotas & Usage")
          )
          .child(div().flex_1())
          // Refresh Button
          .child(
            h_flex()
              .px(8)
              .h(26)
              .rounded(5)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.refresh(cx))
              .child(div().text_size(12).text_color(t.muted).child(this.loading ? "Refreshing…" : "↻ Refresh"))
          )
          // Close Button
          .child(
            h_flex()
              .w(26)
              .h(26)
              .rounded(5)
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.close())
              .child(div().text_size(14).text_color(t.muted).child("✕"))
          )
      )
      // Cards Container
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(16)
          .gap(14)
          // --- Card 1: Claude Code ---
          .child(
            v_flex()
              .p(14)
              .gap(10)
              .rounded(10)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              // Header line
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(image("custom-icons/claude.svg").w(18).h(18).flex_none())
                      .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Claude Code"))
                      .child(
                        div()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(claude?.tier || "Official")
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(claude?.org ? `Org: ${claude.org}` : "")
                  )
              )
              // Dimension: 5hr (shown only if available)
              .when(Boolean(claude?.hasFiveHour), (el) =>
                el.child(
                  h_flex()
                    .p(8)
                    .rounded(6)
                    .bg(t.background)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(div().text_size(11.5).font_semibold().text_color(t.accent).child("5hr Window:"))
                        .child(div().text_size(12).text_color(t.foreground).child(`${claude.fiveHour.percent}% used`))
                    )
                    .when(Boolean(claude.fiveHour.timeRemaining), (tEl) =>
                      tEl.child(
                        div()
                          .px(5)
                          .py(1)
                          .rounded(4)
                          .bg(t.surface)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(`Resets ${claude.fiveHour.timeRemaining}`)
                      )
                    )
                )
              )
              // Dimension: week (shown only if available)
              .when(Boolean(claude?.hasWeek), (el) =>
                el.child(
                  v_flex()
                    .p(8)
                    .gap(6)
                    .rounded(6)
                    .bg(t.background)
                    .child(
                      h_flex()
                        .items_center()
                        .justify_between()
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().text_size(11.5).font_semibold().text_color(t.accent).child("Week Limit:"))
                            .child(div().text_size(12).font_medium().text_color(sevenDayColor).child(`${sevenDayPercent}% used`))
                        )
                        .when(Boolean(claude.week.timeRemaining), (tEl) =>
                          tEl.child(
                            div()
                              .px(5)
                              .py(1)
                              .rounded(4)
                              .bg(t.surface)
                              .text_size(10.5)
                              .text_color(t.dim)
                              .child(`Resets ${claude.week.timeRemaining}`)
                          )
                        )
                    )
                    .child(
                      h_flex()
                        .h(6)
                        .w_full()
                        .rounded(3)
                        .bg(t.surface)
                        .overflow_hidden()
                        .child(
                          div()
                            .h_full()
                            .w(`${Math.max(1, Math.min(100, sevenDayPercent))}%`)
                            .bg(sevenDayColor)
                            .rounded(3)
                        )
                    )
                )
              )
              // Dimension: credit (shown only if purchased / enabled)
              .when(Boolean(claude?.hasCredit), (eEl) => {
                const creditPercent = claude.credit.percent ?? 0;
                const creditColor = getBarColor(t, creditPercent);
                return eEl.child(
                  v_flex()
                    .p(8)
                    .gap(6)
                    .rounded(6)
                    .bg(t.background)
                    .child(
                      h_flex()
                        .items_center()
                        .justify_between()
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().text_size(11.5).font_semibold().text_color(t.accent).child("Extra Credit Spend:"))
                            .child(
                              div()
                                .text_size(12)
                                .font_medium()
                                .text_color(t.foreground)
                                .child(`${claude.credit.used} / ${claude.credit.limit}`)
                            )
                        )
                        .child(
                          div()
                            .text_size(11.5)
                            .font_medium()
                            .text_color(creditColor)
                            .child(`${creditPercent}% used`)
                        )
                    )
                    .child(
                      h_flex()
                        .h(6)
                        .w_full()
                        .rounded(3)
                        .bg(t.surface)
                        .overflow_hidden()
                        .child(
                          div()
                            .h_full()
                            .w(`${Math.max(1, Math.min(100, creditPercent))}%`)
                            .bg(creditColor)
                            .rounded(3)
                        )
                    )
                );
              })
          )
          // --- Card 2: Codex ---
          .child(
            v_flex()
              .p(14)
              .gap(10)
              .rounded(10)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(8)
                      .items_center()
                      .child(image("custom-icons/codex.svg").w(18).h(18).flex_none())
                      .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Codex"))
                      .child(
                        div()
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.raised)
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(codex?.plan || "PROLITE")
                      )
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(`Model: ${codex?.model || "GPT-5"}`)
                  )
              )
              // Week Quota line (if hasWeek)
              .when(Boolean(codex?.hasWeek), (wEl) =>
                wEl.child(
                  v_flex()
                    .gap(4)
                    .child(
                      h_flex()
                        .items_center()
                        .justify_between()
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().text_size(12).font_medium().text_color(t.foreground).child("7-Day Rolling Usage"))
                            .child(
                              div()
                                .text_size(11)
                                .text_color(t.dim)
                                .child(codex.week.timeRemaining ? `(resets ${codex.week.timeRemaining})` : "")
                            )
                        )
                        .child(
                          div()
                            .text_size(12)
                            .font_semibold()
                            .text_color(getBarColor(t, codex.week.percent))
                            .child(`${codex.week.percent}%`)
                        )
                    )
                    .child(
                      h_flex()
                        .h(6)
                        .w_full()
                        .rounded(3)
                        .bg(t.background)
                        .overflow_hidden()
                        .child(
                          div()
                            .h_full()
                            .w(`${Math.max(2, Math.min(100, codex.week.percent))}%`)
                            .bg(getBarColor(t, codex.week.percent))
                            .rounded(3)
                        )
                    )
                )
              )
              // Reset credits banner (if available)
              .when(Boolean(codex?.resetCredits && codex.resetCredits > 0), (rEl) =>
                rEl.child(
                  h_flex()
                    .p(8)
                    .rounded(6)
                    .bg(t.background)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .child(div().text_size(11.5).font_semibold().text_color(t.ansi2).child("✨ Free Resets:"))
                        .child(
                          div()
                            .text_size(12)
                            .font_medium()
                            .text_color(t.foreground)
                            .child(`${codex.resetCredits} available`)
                        )
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child("Full quota reset granted")
                    )
                )
              )
              // Metrics line
              .child(
                h_flex()
                  .gap(10)
                  .child(
                    v_flex()
                      .flex_1()
                      .p(10)
                      .rounded(6)
                      .bg(t.background)
                      .gap(2)
                      .child(div().text_size(11).text_color(t.dim).child("Today's Token Volume"))
                      .child(div().text_size(17).font_semibold().text_color(t.foreground).child(codex?.formattedTokens || "0"))
                  )
                  .child(
                    v_flex()
                      .flex_1()
                      .p(10)
                      .rounded(6)
                      .bg(t.background)
                      .gap(2)
                      .child(div().text_size(11).text_color(t.dim).child("Today's Active Turns"))
                      .child(div().text_size(17).font_semibold().text_color(t.foreground).child(String(codex?.turnsToday || 0)))
                  )
              )
          )
      )
      // Footer hint
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .px(16)
          .items_center()
          .justify_between()
          .bg(t.surface)
          .border_t(1)
          .border_color(t.border)
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(this.data?.updatedAt ? `Last refreshed: ${new Date(this.data.updatedAt).toLocaleTimeString()}` : "")
          )
          .child(div().text_size(11).text_color(t.dim).child("Press Esc to close"))
      );
  }

  render(cx) {
    const t = theme();
    if (this.role === "widget") {
      return this.renderWidget(t, cx);
    }
    return this.renderDialog(t, cx);
  }
}
