// 听写词典只保存词条，不在 renderer 端推断替换规则。
// 主进程会把这些词条作为 Whisper prompt 偏置传入，因此必须去重、限长，避免无意义地放大请求。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";

const MAX_DICTIONARY_ENTRIES = 50;
const MAX_ENTRY_LENGTH = 80;

export interface SpeechDictationDictionaryProps {
  entries: string[];
  onChange: (entries: string[]) => void;
}

export function SpeechDictationDictionary({ entries, onChange }: SpeechDictationDictionaryProps) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState("");
  const normalizedDraft = draft.trim().slice(0, MAX_ENTRY_LENGTH);
  const canAdd = normalizedDraft.length > 0 && !entries.includes(normalizedDraft) && entries.length < MAX_DICTIONARY_ENTRIES;

  const add = () => {
    if (!canAdd) return;
    onChange([...entries, normalizedDraft]);
    setDraft("");
  };

  return (
    <div className="pw-speech-dictionary">
      <p className="pw-speech-dictionary-note">{t("speech.dictionaryDesc")}</p>
      <div className="pw-speech-dictionary-add">
        <input
          className="pw-set-input"
          value={draft}
          maxLength={MAX_ENTRY_LENGTH}
          placeholder={t("speech.dictionaryPlaceholder")}
          aria-label={t("speech.dictionary")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button className="btn pw-pi-add-btn" type="button" disabled={!canAdd} onClick={add}>
          <Icon.Plus size={13} />
          {t("speech.dictionaryAdd")}
        </button>
      </div>
      {entries.length > 0 ? (
        <ul className="pw-speech-dictionary-list" aria-label={t("speech.dictionary")}>
          {entries.map((entry) => (
            <li key={entry}>
              <span>{entry}</span>
              <button
                className="pw-icon-btn"
                type="button"
                aria-label={t("speech.dictionaryRemove", { entry })}
                onClick={() => onChange(entries.filter((candidate) => candidate !== entry))}
              >
                <Icon.X size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pw-muted">{t("speech.dictionaryEmpty")}</p>
      )}
    </div>
  );
}
