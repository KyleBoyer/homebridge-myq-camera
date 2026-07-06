const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

function nals(data: Buffer): Array<{ type: number; data: Buffer }> {
  const starts: number[] = [];
  for (let index = 0; index + 3 <= data.length;) {
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
      starts.push(index);
      index += 3;
    } else if (
      index + 4 <= data.length
      && data[index] === 0 && data[index + 1] === 0
      && data[index + 2] === 0 && data[index + 3] === 1
    ) {
      starts.push(index);
      index += 4;
    } else {
      index += 1;
    }
  }
  return starts.flatMap((start, position) => {
    const end = starts[position + 1] ?? data.length;
    const nal = data.subarray(start, end);
    const offset = nal[2] === 1 ? 3 : 4;
    return nal.length > offset ? [{ type: nal[offset] & 0x1f, data: nal }] : [];
  });
}

export class KeyframeGate {
  private open = false;
  private sps?: Buffer;
  private pps?: Buffer;

  feed(accessUnit: Buffer): Buffer[] {
    let idr = false;
    const units = nals(accessUnit);
    for (const unit of units) {
      if (unit.type === NAL_SPS) this.sps = unit.data;
      else if (unit.type === NAL_PPS) this.pps = unit.data;
      else if (unit.type === NAL_IDR) idr = true;
    }
    if (this.open) return [accessUnit];
    if (!idr || !this.sps || !this.pps) return [];
    this.open = true;
    if (units[0] && [NAL_SPS, NAL_PPS].includes(units[0].type)) return [accessUnit];
    return [this.sps, this.pps, accessUnit];
  }
}
