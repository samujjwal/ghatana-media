// AudioWorklet processor: hands each 128-sample render quantum of its input to the page, unchanged.
class LiveCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("live-capture", LiveCaptureProcessor);
