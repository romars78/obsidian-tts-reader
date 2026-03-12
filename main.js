/*
 * TTS Reader Plugin for Obsidian
 * 문서를 소리내어 읽어주는 플러그인
 * 한국어/영어/한자 지원, 모바일 호환
 */

"use strict";

const obsidian = require("obsidian");

// ─── 마크다운 → 순수 텍스트 변환 ───
function stripMarkdown(text) {
  return text
    // YAML frontmatter 제거
    .replace(/^---[\s\S]*?---\n*/m, "")
    // 코드 블록 제거
    .replace(/```[\s\S]*?```/g, "")
    // 인라인 코드 제거
    .replace(/`[^`]*`/g, "")
    // 이미지 제거
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    // 링크 → 텍스트만
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 위키링크 [[link|display]] → display
    .replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, "$2")
    // HTML 태그 제거
    .replace(/<[^>]+>/g, "")
    // 헤딩 # 제거
    .replace(/^#{1,6}\s+/gm, "")
    // 볼드/이탤릭
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // 취소선
    .replace(/~~([^~]+)~~/g, "$1")
    // 하이라이트
    .replace(/==([^=]+)==/g, "$1")
    // 블록 인용
    .replace(/^>\s?/gm, "")
    // 수평선
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // 리스트 마커
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    // 체크박스
    .replace(/\[[ x]\]\s*/gi, "")
    // 태그
    .replace(/#[^\s#]+/g, "")
    // callout 헤더
    .replace(/^\[![\w]+\][-+]?\s*/gm, "")
    // 여러 줄바꿈 정리
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── 기본 설정 ───
const DEFAULT_SETTINGS = {
  rate: 1.0,
  pitch: 1.0,
  voiceName: "",
  highlightWhileReading: true,
};

// ─── 메인 플러그인 ───
class TtsReaderPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.synth = window.speechSynthesis;
    this.utterance = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.statusBarEl = null;
    this.ribbonPlayEl = null;
    this.currentText = "";
    this.chunks = [];
    this.currentChunkIndex = 0;
  }

  async onload() {
    await this.loadSettings();

    // 리본 아이콘 (재생 버튼) — 모바일에서도 보임
    this.ribbonPlayEl = this.addRibbonIcon("audio-lines", "TTS: 문서 읽기", () => {
      if (this.isPlaying) {
        this.stopReading();
      } else {
        this.readDocument();
      }
    });

    // 상태바 (데스크탑)
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // 명령어 등록
    this.addCommand({
      id: "read-document",
      name: "전체 문서 읽기",
      callback: () => this.readDocument(),
    });

    this.addCommand({
      id: "read-selection",
      name: "선택 텍스트 읽기",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (selection) {
          this.readText(selection);
        } else {
          new obsidian.Notice("텍스트를 선택해주세요");
        }
      },
    });

    this.addCommand({
      id: "pause-resume",
      name: "일시정지 / 다시 재생",
      callback: () => this.togglePauseResume(),
    });

    this.addCommand({
      id: "stop-reading",
      name: "읽기 중지",
      callback: () => this.stopReading(),
    });

    this.addCommand({
      id: "rate-up",
      name: "속도 올리기 (+0.25)",
      callback: () => this.adjustRate(0.25),
    });

    this.addCommand({
      id: "rate-down",
      name: "속도 내리기 (-0.25)",
      callback: () => this.adjustRate(-0.25),
    });

    // 설정 탭
    this.addSettingTab(new TtsSettingTab(this.app, this));

    console.log("TTS Reader loaded");
  }

  onunload() {
    this.stopReading();
    console.log("TTS Reader unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ─── 문서 전체 읽기 ───
  readDocument() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) {
      new obsidian.Notice("열린 마크다운 문서가 없습니다");
      return;
    }
    // Reading 모드든 Edit 모드든 에디터에서 텍스트 가져옴
    const text = view.editor.getValue();
    if (!text.trim()) {
      new obsidian.Notice("문서가 비어있습니다");
      return;
    }
    this.readText(text);
  }

  // ─── 텍스트 읽기 (핵심) ───
  readText(rawText) {
    // 기존 재생 중지
    this.stopReading();

    const text = stripMarkdown(rawText);
    if (!text) {
      new obsidian.Notice("읽을 내용이 없습니다");
      return;
    }

    this.currentText = text;

    // 긴 텍스트를 청크로 분할 (모바일 호환성 — 일부 기기에서 긴 텍스트 끊김)
    this.chunks = this.splitIntoChunks(text, 200);
    this.currentChunkIndex = 0;

    new obsidian.Notice("🔊 읽기 시작");
    this.isPlaying = true;
    this.isPaused = false;
    this.updateStatusBar();
    this.updateRibbonIcon();

    this.speakCurrentChunk();
  }

  // 텍스트를 문장 단위로 청크 분할
  splitIntoChunks(text, maxLength) {
    const chunks = [];
    // 문장 단위로 분할 (마침표, 물음표, 느낌표, 줄바꿈)
    const sentences = text.split(/(?<=[.?!。！？\n])\s*/);
    let current = "";

    for (const sentence of sentences) {
      if (!sentence.trim()) continue;
      if ((current + " " + sentence).length > maxLength && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = current ? current + " " + sentence : sentence;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }

    // 혹시 빈 배열이면 원본 텍스트를 강제 분할
    if (chunks.length === 0) {
      for (let i = 0; i < text.length; i += maxLength) {
        chunks.push(text.substring(i, i + maxLength));
      }
    }

    return chunks;
  }

  speakCurrentChunk() {
    if (this.currentChunkIndex >= this.chunks.length) {
      this.onFinished();
      return;
    }

    const chunk = this.chunks[this.currentChunkIndex];
    this.utterance = new SpeechSynthesisUtterance(chunk);
    this.utterance.rate = this.settings.rate;
    this.utterance.pitch = this.settings.pitch;
    this.utterance.lang = "ko-KR";

    // 음성 선택
    if (this.settings.voiceName) {
      const voices = this.synth.getVoices();
      const voice = voices.find((v) => v.name === this.settings.voiceName);
      if (voice) {
        this.utterance.voice = voice;
        this.utterance.lang = voice.lang;
      }
    }

    this.utterance.onend = () => {
      this.currentChunkIndex++;
      if (this.isPlaying && !this.isPaused) {
        this.speakCurrentChunk();
      }
    };

    this.utterance.onerror = (event) => {
      if (event.error !== "canceled" && event.error !== "interrupted") {
        console.error("TTS error:", event.error);
        new obsidian.Notice("TTS 오류: " + event.error);
      }
      this.stopReading();
    };

    this.synth.speak(this.utterance);
  }

  onFinished() {
    this.isPlaying = false;
    this.isPaused = false;
    this.utterance = null;
    this.updateStatusBar();
    this.updateRibbonIcon();
    new obsidian.Notice("✅ 읽기 완료");
  }

  // ─── 일시정지 / 다시 재생 ───
  togglePauseResume() {
    if (!this.isPlaying) {
      // 재생 중이 아니면 문서 읽기 시작
      this.readDocument();
      return;
    }

    if (this.isPaused) {
      this.synth.resume();
      this.isPaused = false;
      new obsidian.Notice("▶ 다시 재생");
    } else {
      this.synth.pause();
      this.isPaused = true;
      new obsidian.Notice("⏸ 일시정지");
    }
    this.updateStatusBar();
  }

  // ─── 중지 ───
  stopReading() {
    this.synth.cancel();
    this.isPlaying = false;
    this.isPaused = false;
    this.utterance = null;
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.updateStatusBar();
    this.updateRibbonIcon();
  }

  // ─── 속도 조절 ───
  adjustRate(delta) {
    this.settings.rate = Math.max(0.25, Math.min(4.0, this.settings.rate + delta));
    this.saveSettings();
    new obsidian.Notice("속도: " + this.settings.rate.toFixed(2) + "x");

    // 재생 중이면 현재 청크부터 다시 재생
    if (this.isPlaying) {
      this.synth.cancel();
      this.speakCurrentChunk();
    }
  }

  // ─── UI 업데이트 ───
  updateStatusBar() {
    if (!this.statusBarEl) return;
    if (this.isPlaying && this.isPaused) {
      this.statusBarEl.setText("TTS ⏸ " + this.settings.rate.toFixed(2) + "x");
    } else if (this.isPlaying) {
      this.statusBarEl.setText("TTS ▶ " + this.settings.rate.toFixed(2) + "x");
    } else {
      this.statusBarEl.setText("TTS " + this.settings.rate.toFixed(2) + "x");
    }
  }

  updateRibbonIcon() {
    if (!this.ribbonPlayEl) return;
    if (this.isPlaying) {
      this.ribbonPlayEl.setAttribute("aria-label", "TTS: 읽기 중지");
    } else {
      this.ribbonPlayEl.setAttribute("aria-label", "TTS: 문서 읽기");
    }
  }
}

// ─── 설정 탭 ───
class TtsSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "TTS Reader 설정" });

    // 속도
    new obsidian.Setting(containerEl)
      .setName("읽기 속도")
      .setDesc("0.25 ~ 4.0 (기본: 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.25, 4.0, 0.25)
          .setValue(this.plugin.settings.rate)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.rate = value;
            await this.plugin.saveSettings();
          })
      );

    // 피치
    new obsidian.Setting(containerEl)
      .setName("음높이 (pitch)")
      .setDesc("0.5 ~ 2.0 (기본: 1.0)")
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 2.0, 0.1)
          .setValue(this.plugin.settings.pitch)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pitch = value;
            await this.plugin.saveSettings();
          })
      );

    // 음성 선택
    const voiceSetting = new obsidian.Setting(containerEl)
      .setName("음성 선택")
      .setDesc("시스템에서 사용 가능한 음성 목록");

    // 음성 로드 (비동기일 수 있음)
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      voiceSetting.addDropdown((dropdown) => {
        dropdown.addOption("", "시스템 기본값");

        // 한국어 음성 먼저
        const koVoices = voices.filter((v) => v.lang.startsWith("ko"));
        const enVoices = voices.filter((v) => v.lang.startsWith("en"));
        const otherVoices = voices.filter(
          (v) => !v.lang.startsWith("ko") && !v.lang.startsWith("en")
        );

        if (koVoices.length > 0) {
          koVoices.forEach((v) => {
            dropdown.addOption(v.name, "🇰🇷 " + v.name);
          });
        }
        if (enVoices.length > 0) {
          enVoices.forEach((v) => {
            dropdown.addOption(v.name, "🇺🇸 " + v.name);
          });
        }
        otherVoices.forEach((v) => {
          dropdown.addOption(v.name, v.name + " (" + v.lang + ")");
        });

        dropdown.setValue(this.plugin.settings.voiceName);
        dropdown.onChange(async (value) => {
          this.plugin.settings.voiceName = value;
          await this.plugin.saveSettings();
        });
      });
    };

    // 일부 브라우저에서 음성 목록이 비동기로 로드됨
    if (window.speechSynthesis.getVoices().length > 0) {
      loadVoices();
    } else {
      window.speechSynthesis.onvoiceschanged = () => loadVoices();
    }

    // 테스트 버튼
    new obsidian.Setting(containerEl)
      .setName("음성 테스트")
      .setDesc("현재 설정으로 테스트 문장을 읽어봅니다")
      .addButton((button) =>
        button.setButtonText("테스트").onClick(() => {
          window.speechSynthesis.cancel();
          const utt = new SpeechSynthesisUtterance(
            "안녕하세요. TTS 리더 테스트입니다. Hello, this is a test."
          );
          utt.rate = this.plugin.settings.rate;
          utt.pitch = this.plugin.settings.pitch;
          utt.lang = "ko-KR";

          if (this.plugin.settings.voiceName) {
            const voices = window.speechSynthesis.getVoices();
            const voice = voices.find((v) => v.name === this.plugin.settings.voiceName);
            if (voice) {
              utt.voice = voice;
              utt.lang = voice.lang;
            }
          }

          window.speechSynthesis.speak(utt);
        })
      );
  }
}

module.exports = TtsReaderPlugin;
