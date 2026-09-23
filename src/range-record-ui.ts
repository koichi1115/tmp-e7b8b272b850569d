/**
 * 保存記録の出し入れ。localStorage への保存・消去・復元と、
 * 読めなかった時の知らせだけを持ちます。保存の形そのものは prepared-record.ts の受け持ちです。
 */
import { PREPARED_FIXTURE_KEY, type Bbox, type FixtureData } from "./fixture.ts";
import {
  serializePreparedRecord,
  type PreparedRecord,
} from "./prepared-record.ts";

export type RangeRecordPorts = Readonly<{
  dialog: HTMLDialogElement;
  useDemo: HTMLButtonElement;
  clearRecord: HTMLButtonElement;
  /** 起動時に読めた記録。読めなければ null です。 */
  restored: PreparedRecord | null;
  /** 起動時に読めなかった理由。空なら何も起きません。 */
  initialError: string;
  writeBbox: (bbox: Bbox) => void;
  showError: (message: string, code?: string) => void;
  /** 記録を捨てた時に、下書きと経由順も一緒に捨てます。 */
  onForget: () => void;
  /** 記録から戻した中身を、下書きと経由順に配ります。 */
  onRestore: (record: PreparedRecord) => void;
  /** 経由UIの描き直し。 */
  refreshVia: () => void;
  onPrepared: (fixture: FixtureData) => void;
  onDemo: () => void;
}>;

export type RangeRecordUi = Readonly<{
  /** 準備できた fixture を保存し、本編へ渡してダイアログを閉じます。 */
  save: (
    bbox: Bbox,
    fixture: FixtureData,
    viaNodeIds: readonly number[],
  ) => void;
  /** 保存済みの範囲と経由順を、通信なしでそのまま編集できる状態に戻します。 */
  restore: () => void;
  /** 起動時に記録が読めなかったことを、黙って消さずに見せます。 */
  showInitialError: () => void;
}>;

export const setupRangeRecordUi = (
  ports: RangeRecordPorts,
): RangeRecordUi => {
  const { dialog } = ports;

  ports.clearRecord.addEventListener("click", () => {
    localStorage.removeItem(PREPARED_FIXTURE_KEY);
    ports.onForget();
    ports.showError("");
    ports.refreshVia();
    ports.onDemo();
    dialog.dataset.state = "cleared";
    dialog.close();
  });

  ports.useDemo.addEventListener("click", () => {
    localStorage.removeItem(PREPARED_FIXTURE_KEY);
    ports.onForget();
    ports.refreshVia();
    ports.onDemo();
    dialog.close();
  });

  return {
    save: (bbox, fixture, viaNodeIds) => {
      localStorage.setItem(
        PREPARED_FIXTURE_KEY,
        serializePreparedRecord({ bbox, viaNodeIds, fixture }),
      );
      ports.onPrepared(fixture);
      dialog.dataset.state = "prepared";
      dialog.close();
    },
    restore: () => {
      if (!ports.restored) {
        return;
      }
      const record = ports.restored;
      ports.writeBbox(record.bbox);
      ports.onRestore(record);
    },
    showInitialError: () => {
      if (!ports.initialError) {
        return;
      }
      queueMicrotask(() => {
        dialog.showModal();
        ports.showError(ports.initialError, "record");
      });
    },
  };
};
