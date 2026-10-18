import assert from 'node:assert/strict';
import {validateAttentionOutput, validateModelTensor, validateDecoderOutputs, InvalidModelOutputError} from '../frontend/src/features/jumper/modelOutputs.ts';
const tensor = dims => ({dims, data:new Float32Array(dims.reduce((a,b)=>a*b,1)).fill(-1024)});
const valid = () => ({masks:tensor([1,4,256,256]),quality:tensor([1,4]),pointers:tensor([1,4,256]),scores:tensor([1,1])});
validateDecoderOutputs(valid());
for (const key of ['masks','quality','pointers','scores']) {
  for (const bad of [undefined, null, {}, {dims:[1],data:new Float32Array(1)}]) {
    const result=valid(); result[key]=bad;
    assert.throws(()=>validateDecoderOutputs(result), InvalidModelOutputError);
  }
  for (const value of [NaN,Infinity,-Infinity]) {
    const result=valid(); result[key].data[result[key].data.length-1]=value;
    assert.throws(()=>validateDecoderOutputs(result), /Retry processing/);
  }
  const short=valid(); short[key].data=short[key].data.slice(1);
  assert.throws(()=>validateDecoderOutputs(short), InvalidModelOutputError);
}
// Same number of elements with the wrong rank/order is still invalid.
const reshaped=valid();reshaped.masks.dims=[4,1,256,256];
assert.throws(()=>validateDecoderOutputs(reshaped), InvalidModelOutputError);
for (const data of [[0,0],new Float64Array(2),new Int32Array(2),new Array(2)])
  assert.throws(()=>validateModelTensor({dims:[2],data},[2],'mask'), InvalidModelOutputError);
for (const dims of [[4096,1,64],[4096,1,256]]) {
  const output=tensor(dims);validateModelTensor(output,dims,'memory');
  output.data[100]=NaN;
  assert.throws(()=>validateModelTensor(output,dims,'memory'),InvalidModelOutputError);
}
console.log('Jumper model-output validation passed');

// Actual pinned memory_attention.onnx output, verified with ONNX Runtime.
const attention=tensor([1,1,4096,256]);
validateAttentionOutput(attention);
assert.throws(()=>validateAttentionOutput(tensor([4096,1,256])), InvalidModelOutputError);
attention.data[attention.data.length-1]=NaN;
assert.throws(()=>validateAttentionOutput(attention), InvalidModelOutputError);
