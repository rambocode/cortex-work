// Cortex SenseVoiceSmall 常驻 sidecar。
//
// 推理实现派生自 FunASR runtime-llamacpp-v0.1.9 的 funasr-sensevoice.cpp，保留其
// SenseVoiceSmall SAN-M + CTC 图和 SentencePiece detokenize；变化仅在进程边界：模型启动时
// 加载一次，stdin 接收长度前缀 PCM16 帧，每个 END 做一次整句推理，stdout 只输出 JSONL。
// SPDX-License-Identifier: Apache-2.0

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "gguf.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

constexpr float LN_EPS = 1e-5f;
constexpr int SAMPLE_RATE = 16000;
constexpr int WIN_LEN = 400;
constexpr int SHIFT = 160;
constexpr int NFFT = 512;
constexpr int NMEL = 80;
constexpr int LFR_M = 7;
constexpr int LFR_N = 6;
constexpr int FBANK_DIM = 560;
constexpr float PREEMPH = 0.97f;
constexpr float LOW_FREQ = 20.0f;
constexpr float HIGH_FREQ = 8000.0f;
constexpr size_t MAX_PCM_BYTES = 16000u * 2u * 30u;

enum FrameType : uint8_t { BEGIN = 1, AUDIO = 2, END = 3, CANCEL = 4, SHUTDOWN = 5 };

float mel(float frequency) { return 1127.0f * std::log(1.0f + frequency / 700.0f); }

void fft(std::vector<float>& real, std::vector<float>& imag, int size) {
  for (int i = 1, j = 0; i < size; ++i) {
    int bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(real[i], real[j]);
      std::swap(imag[i], imag[j]);
    }
  }
  for (int length = 2; length <= size; length <<= 1) {
    const double angle = -2.0 * M_PI / length;
    const float wr = std::cos(angle);
    const float wi = std::sin(angle);
    for (int start = 0; start < size; start += length) {
      float cr = 1.0f;
      float ci = 0.0f;
      for (int offset = 0; offset < length / 2; ++offset) {
        const float ur = real[start + offset];
        const float ui = imag[start + offset];
        const float vr = real[start + offset + length / 2] * cr - imag[start + offset + length / 2] * ci;
        const float vi = real[start + offset + length / 2] * ci + imag[start + offset + length / 2] * cr;
        real[start + offset] = ur + vr;
        imag[start + offset] = ui + vi;
        real[start + offset + length / 2] = ur - vr;
        imag[start + offset + length / 2] = ui - vi;
        const float next_cr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next_cr;
      }
    }
  }
}

std::vector<float> compute_fbank(std::vector<float> wav, int& output_frames) {
  if (wav.size() < WIN_LEN) throw std::runtime_error("audio_too_short");
  for (float& value : wav) value *= 32768.0f;
  std::vector<float> window(WIN_LEN);
  for (int i = 0; i < WIN_LEN; ++i) window[i] = 0.54f - 0.46f * std::cos(2.0f * M_PI * i / (WIN_LEN - 1));

  constexpr int bins = NFFT / 2 + 1;
  const float bin_width = static_cast<float>(SAMPLE_RATE) / NFFT;
  const float low_mel = mel(LOW_FREQ);
  const float high_mel = mel(HIGH_FREQ);
  const float delta_mel = (high_mel - low_mel) / (NMEL + 1);
  std::vector<std::vector<float>> filters(NMEL, std::vector<float>(bins, 0.0f));
  for (int m = 0; m < NMEL; ++m) {
    const float left = low_mel + m * delta_mel;
    const float center = low_mel + (m + 1) * delta_mel;
    const float right = low_mel + (m + 2) * delta_mel;
    for (int k = 0; k < bins; ++k) {
      const float value = mel(bin_width * k);
      if (value > left && value < right) {
        filters[m][k] = value <= center ? (value - left) / (center - left) : (right - value) / (right - center);
      }
    }
  }

  const int frame_count = (static_cast<int>(wav.size()) - WIN_LEN) / SHIFT + 1;
  std::vector<std::vector<float>> features(frame_count, std::vector<float>(NMEL));
  std::vector<float> real(NFFT), imag(NFFT), frame(WIN_LEN);
  constexpr float floor = 1.1920929e-07f;
  for (int t = 0; t < frame_count; ++t) {
    const float* samples = wav.data() + t * SHIFT;
    double mean = 0.0;
    for (int i = 0; i < WIN_LEN; ++i) mean += samples[i];
    mean /= WIN_LEN;
    for (int i = 0; i < WIN_LEN; ++i) frame[i] = samples[i] - static_cast<float>(mean);
    for (int i = WIN_LEN - 1; i > 0; --i) frame[i] -= PREEMPH * frame[i - 1];
    frame[0] -= PREEMPH * frame[0];
    for (int i = 0; i < NFFT; ++i) {
      real[i] = i < WIN_LEN ? frame[i] * window[i] : 0.0f;
      imag[i] = 0.0f;
    }
    fft(real, imag, NFFT);
    for (int m = 0; m < NMEL; ++m) {
      float energy = 0.0f;
      for (int k = 0; k < bins; ++k) {
        if (filters[m][k] > 0) energy += filters[m][k] * (real[k] * real[k] + imag[k] * imag[k]);
      }
      features[t][m] = std::log(energy > floor ? energy : floor);
    }
  }

  const int pad = (LFR_M - 1) / 2;
  const int lfr_frames = (frame_count + LFR_N - 1) / LFR_N;
  std::vector<std::vector<float>> padded;
  padded.reserve(frame_count + pad + LFR_M);
  for (int i = 0; i < pad; ++i) padded.push_back(features.front());
  for (const auto& feature : features) padded.push_back(feature);
  while (static_cast<int>(padded.size()) < (lfr_frames - 1) * LFR_N + LFR_M) padded.push_back(features.back());
  std::vector<float> output(static_cast<size_t>(lfr_frames) * FBANK_DIM);
  for (int i = 0; i < lfr_frames; ++i) {
    for (int j = 0; j < LFR_M; ++j) {
      std::memcpy(&output[static_cast<size_t>(i) * FBANK_DIM + j * NMEL], padded[i * LFR_N + j].data(), NMEL * sizeof(float));
    }
  }
  output_frames = lfr_frames;
  return output;
}

struct Config {
  int model_dim = 512;
  int heads = 4;
  int blocks = 50;
  int tp_blocks = 20;
  int kernel = 11;
  int vocab = 25055;
  int blank = 0;
};

struct Model {
  Config config;
  ggml_context* weights = nullptr;
  std::map<std::string, ggml_tensor*> tensors;
  std::vector<int> query_tokens;
  std::vector<std::string> vocab;

  ggml_tensor* get(const std::string& name) {
    const auto found = tensors.find(name);
    if (found == tensors.end()) throw std::runtime_error("missing_tensor:" + name);
    return found->second;
  }
};

ggml_tensor* linear(ggml_context* context, ggml_tensor* weight, ggml_tensor* bias, ggml_tensor* input) {
  auto* output = ggml_mul_mat(context, weight, input);
  return bias ? ggml_add(context, output, bias) : output;
}

ggml_tensor* layer_norm(ggml_context* context, ggml_tensor* input, ggml_tensor* gain, ggml_tensor* bias) {
  return ggml_add(context, ggml_mul(context, ggml_norm(context, input, LN_EPS), gain), bias);
}

ggml_tensor* attention(ggml_context* context, Model& model, const std::string& prefix, ggml_tensor* input, int frames) {
  const int dim = model.config.model_dim;
  const int heads = model.config.heads;
  const int head_dim = dim / heads;
  const int kernel = model.config.kernel;
  auto* qkv = linear(context, model.get(prefix + "linear_q_k_v.weight"), model.get(prefix + "linear_q_k_v.bias"), input);
  const size_t row_bytes = qkv->nb[1];
  auto* query = ggml_cont(context, ggml_view_2d(context, qkv, dim, frames, row_bytes, 0));
  auto* key = ggml_cont(context, ggml_view_2d(context, qkv, dim, frames, row_bytes, static_cast<size_t>(dim) * sizeof(float)));
  auto* value = ggml_cont(context, ggml_view_2d(context, qkv, dim, frames, row_bytes, static_cast<size_t>(2 * dim) * sizeof(float)));
  const int pad = (kernel - 1) / 2;
  auto* fsmn_weight = model.get(prefix + "fsmn_block.weight");
  auto* padded = ggml_pad_ext(context, value, 0, 0, pad, pad, 0, 0, 0, 0);
  auto* fsmn = value;
  for (int i = 0; i < kernel; ++i) {
    auto* slice = ggml_view_2d(context, padded, dim, frames, padded->nb[1], static_cast<size_t>(i) * padded->nb[1]);
    auto* weight = ggml_view_1d(context, fsmn_weight, dim, static_cast<size_t>(i) * fsmn_weight->nb[1]);
    fsmn = ggml_add(context, fsmn, ggml_mul(context, ggml_cont(context, slice), weight));
  }
  query = ggml_permute(context, ggml_reshape_3d(context, query, head_dim, heads, frames), 0, 2, 1, 3);
  key = ggml_permute(context, ggml_reshape_3d(context, key, head_dim, heads, frames), 0, 2, 1, 3);
  auto* value_heads = ggml_cont(context, ggml_permute(context, ggml_reshape_3d(context, value, head_dim, heads, frames), 1, 2, 0, 3));
  auto* scores = ggml_soft_max(context, ggml_scale(context, ggml_mul_mat(context, key, query), 1.0f / std::sqrt(static_cast<float>(head_dim))));
  auto* output = ggml_cont_2d(context, ggml_permute(context, ggml_mul_mat(context, value_heads, scores), 0, 2, 1, 3), dim, frames);
  return ggml_add(context, linear(context, model.get(prefix + "linear_out.weight"), model.get(prefix + "linear_out.bias"), output), fsmn);
}

ggml_tensor* sanm_layer(ggml_context* context, Model& model, const std::string& prefix, ggml_tensor* input, int frames, bool residual) {
  auto* shortcut = input;
  auto* hidden = layer_norm(context, input, model.get(prefix + "norm1.weight"), model.get(prefix + "norm1.bias"));
  auto* attended = attention(context, model, prefix + "self_attn.", hidden, frames);
  input = residual ? ggml_add(context, shortcut, attended) : attended;
  shortcut = input;
  hidden = layer_norm(context, input, model.get(prefix + "norm2.weight"), model.get(prefix + "norm2.bias"));
  hidden = linear(context, model.get(prefix + "feed_forward.w_1.weight"), model.get(prefix + "feed_forward.w_1.bias"), hidden);
  hidden = ggml_relu(context, hidden);
  hidden = linear(context, model.get(prefix + "feed_forward.w_2.weight"), model.get(prefix + "feed_forward.w_2.bias"), hidden);
  return ggml_add(context, shortcut, hidden);
}

void add_position_encoding(std::vector<float>& input, int frames, int depth) {
  const double increment = std::log(10000.0) / (depth / 2.0 - 1.0);
  for (int frame = 0; frame < frames; ++frame) {
    const double position = frame + 1;
    for (int i = 0; i < depth / 2; ++i) {
      const double value = position * std::exp(i * -increment);
      input[static_cast<size_t>(frame) * depth + i] += static_cast<float>(std::sin(value));
      input[static_cast<size_t>(frame) * depth + depth / 2 + i] += static_cast<float>(std::cos(value));
    }
  }
}

std::string trim(const std::string& value) {
  const size_t start = value.find_first_not_of(' ');
  if (start == std::string::npos) return "";
  const size_t end = value.find_last_not_of(' ');
  return value.substr(start, end - start + 1);
}

std::string detokenize(const std::vector<int>& ids, const std::vector<std::string>& vocab) {
  std::string output;
  for (const int id : ids) {
    if (id < 0 || id >= static_cast<int>(vocab.size())) continue;
    const std::string& piece = vocab[id];
    if (piece.size() >= 2 && piece[0] == '<' && piece[1] == '|') continue;
    output += piece;
  }
  const std::string boundary = "\xe2\x96\x81";
  size_t position;
  while ((position = output.find(boundary)) != std::string::npos) output.replace(position, 3, " ");
  return trim(output);
}

Model load_model(const std::string& path) {
  Model model;
  gguf_init_params params = {false, &model.weights};
  gguf_context* gguf = gguf_init_from_file(path.c_str(), params);
  if (!gguf) throw std::runtime_error("load_gguf_failed");
  const auto read_u32 = [&](const char* key, int fallback) {
    const int index = gguf_find_key(gguf, key);
    return index < 0 ? fallback : static_cast<int>(gguf_get_val_u32(gguf, index));
  };
  model.config.model_dim = read_u32("sv.output_size", 512);
  model.config.heads = read_u32("sv.attention_heads", 4);
  model.config.blocks = read_u32("sv.num_blocks", 50);
  model.config.tp_blocks = read_u32("sv.tp_blocks", 20);
  model.config.kernel = read_u32("sv.kernel_size", 11);
  model.config.vocab = read_u32("sv.vocab_size", 25055);
  model.config.blank = read_u32("sv.blank_id", 0);
  const int query_index = gguf_find_key(gguf, "sv.query_tokens");
  if (query_index >= 0) {
    const int count = static_cast<int>(gguf_get_arr_n(gguf, query_index));
    const auto* values = static_cast<const int32_t*>(gguf_get_arr_data(gguf, query_index));
    model.query_tokens.assign(values, values + count);
  }
  const int vocab_index = gguf_find_key(gguf, "sv.vocab");
  if (vocab_index >= 0) {
    const int count = static_cast<int>(gguf_get_arr_n(gguf, vocab_index));
    model.vocab.resize(count);
    for (int i = 0; i < count; ++i) {
      const char* value = gguf_get_arr_str(gguf, vocab_index, i);
      model.vocab[i] = value ? value : "";
    }
  }
  for (int i = 0; i < gguf_get_n_tensors(gguf); ++i) {
    const char* name = gguf_get_tensor_name(gguf, i);
    model.tensors[name] = ggml_get_tensor(model.weights, name);
  }
  gguf_free(gguf);
  if (model.query_tokens.empty() || model.vocab.empty()) throw std::runtime_error("invalid_sensevoice_gguf_metadata");
  return model;
}

int language_token(const std::string& language) {
  if (language == "zh") return 3;
  if (language == "en") return 4;
  if (language == "yue") return 7;
  if (language == "ja") return 11;
  if (language == "ko") return 12;
  return 0;
}

std::string infer(Model& model, ggml_backend_t backend, const std::vector<int16_t>& pcm, const std::string& language) {
  std::vector<float> wav(pcm.size());
  for (size_t i = 0; i < pcm.size(); ++i) wav[i] = static_cast<float>(pcm[i]) / 32768.0f;
  int frames = 0;
  const std::vector<float> fbank = compute_fbank(std::move(wav), frames);
  std::vector<int> query_tokens = model.query_tokens;
  query_tokens[0] = language_token(language);
  const int query_count = static_cast<int>(query_tokens.size());
  const int total_frames = query_count + frames;
  const int dim = model.config.model_dim;
  const int vocab_size = model.config.vocab;
  std::vector<float> input(static_cast<size_t>(total_frames) * FBANK_DIM);
  const float* embeddings = static_cast<const float*>(model.get("embed.weight")->data);
  for (int i = 0; i < query_count; ++i) {
    std::memcpy(&input[static_cast<size_t>(i) * FBANK_DIM], &embeddings[static_cast<size_t>(query_tokens[i]) * FBANK_DIM], FBANK_DIM * sizeof(float));
  }
  std::memcpy(&input[static_cast<size_t>(query_count) * FBANK_DIM], fbank.data(), static_cast<size_t>(frames) * FBANK_DIM * sizeof(float));
  const float scale = std::sqrt(static_cast<float>(dim));
  for (float& value : input) value *= scale;
  add_position_encoding(input, total_frames, FBANK_DIM);

  ggml_init_params context_params = {static_cast<size_t>(1024) * 1024 * 1024, nullptr, true};
  ggml_context* context = ggml_init(context_params);
  if (!context) throw std::runtime_error("ggml_context_failed");
  ggml_tensor* tensor = ggml_new_tensor_2d(context, GGML_TYPE_F32, FBANK_DIM, total_frames);
  ggml_set_input(tensor);
  ggml_tensor* hidden = sanm_layer(context, model, "encoder.encoders0.0.", tensor, total_frames, false);
  for (int i = 0; i < model.config.blocks - 1; ++i) {
    hidden = sanm_layer(context, model, "encoder.encoders." + std::to_string(i) + ".", hidden, total_frames, true);
  }
  hidden = layer_norm(context, hidden, model.get("encoder.after_norm.weight"), model.get("encoder.after_norm.bias"));
  for (int i = 0; i < model.config.tp_blocks; ++i) {
    hidden = sanm_layer(context, model, "encoder.tp_encoders." + std::to_string(i) + ".", hidden, total_frames, true);
  }
  hidden = layer_norm(context, hidden, model.get("encoder.tp_norm.weight"), model.get("encoder.tp_norm.bias"));
  ggml_tensor* logits = linear(context, model.get("ctc.ctc_lo.weight"), model.get("ctc.ctc_lo.bias"), hidden);
  ggml_set_output(logits);
  ggml_cgraph* graph = ggml_new_graph_custom(context, 32768, false);
  ggml_build_forward_expand(graph, logits);
  ggml_gallocr_t allocator = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  ggml_gallocr_alloc_graph(allocator, graph);
  ggml_backend_tensor_set(tensor, input.data(), 0, ggml_nbytes(tensor));
  ggml_backend_cpu_set_n_threads(backend, std::max(1u, std::min(8u, std::thread::hardware_concurrency())));
  if (ggml_backend_graph_compute(backend, graph) != GGML_STATUS_SUCCESS) {
    ggml_gallocr_free(allocator);
    ggml_free(context);
    throw std::runtime_error("ggml_compute_failed");
  }
  std::vector<float> output(static_cast<size_t>(vocab_size) * total_frames);
  ggml_backend_tensor_get(logits, output.data(), 0, ggml_nbytes(logits));
  std::vector<int> ids;
  int previous = -1;
  for (int frame = 0; frame < total_frames; ++frame) {
    const float* column = &output[static_cast<size_t>(frame) * vocab_size];
    int best_id = 0;
    float best = column[0];
    for (int id = 1; id < vocab_size; ++id) {
      if (column[id] > best) {
        best = column[id];
        best_id = id;
      }
    }
    if (best_id != previous && best_id != model.config.blank) ids.push_back(best_id);
    previous = best_id;
  }
  ggml_gallocr_free(allocator);
  ggml_free(context);
  return detokenize(ids, model.vocab);
}

std::string json_escape(const std::string& value) {
  std::string output;
  output.reserve(value.size() + 8);
  for (const unsigned char ch : value) {
    if (ch == '"') output += "\\\"";
    else if (ch == '\\') output += "\\\\";
    else if (ch == '\n') output += "\\n";
    else if (ch == '\r') output += "\\r";
    else if (ch == '\t') output += "\\t";
    else if (ch < 0x20) output += "?";
    else output += static_cast<char>(ch);
  }
  return output;
}

std::string json_string(const std::string& json, const std::string& key) {
  const std::string marker = "\"" + key + "\"";
  size_t position = json.find(marker);
  if (position == std::string::npos) return "";
  position = json.find(':', position + marker.size());
  if (position == std::string::npos) return "";
  position = json.find('"', position + 1);
  if (position == std::string::npos) return "";
  std::string output;
  for (++position; position < json.size(); ++position) {
    const char ch = json[position];
    if (ch == '"') break;
    if (ch == '\\' && position + 1 < json.size()) {
      const char escaped = json[++position];
      if (escaped == 'n') output += '\n';
      else if (escaped == 'r') output += '\r';
      else if (escaped == 't') output += '\t';
      else output += escaped;
    } else output += ch;
  }
  return output;
}

void emit_ready() {
  std::cout << "{\"type\":\"ready\",\"protocol\":1}" << std::endl;
}

void emit_error(const std::string& request_id, const std::string& code, const std::string& message) {
  std::cout << "{\"type\":\"error\"";
  if (!request_id.empty()) std::cout << ",\"requestId\":\"" << json_escape(request_id) << "\"";
  std::cout << ",\"code\":\"" << json_escape(code) << "\",\"message\":\"" << json_escape(message) << "\"}" << std::endl;
}

bool read_exact(char* target, size_t size) {
  std::cin.read(target, static_cast<std::streamsize>(size));
  return static_cast<size_t>(std::cin.gcount()) == size;
}

uint32_t read_be32(const unsigned char* bytes) {
  return (static_cast<uint32_t>(bytes[0]) << 24) |
         (static_cast<uint32_t>(bytes[1]) << 16) |
         (static_cast<uint32_t>(bytes[2]) << 8) |
         static_cast<uint32_t>(bytes[3]);
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  std::string model_path;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--model") == 0 && i + 1 < argc) model_path = argv[++i];
    else {
      std::cerr << "usage: cortex-sensevoice-sidecar --model <sensevoice-small-q8.gguf>\n";
      return 2;
    }
  }
  if (model_path.empty()) return 2;

  try {
    Model model = load_model(model_path);
    ggml_backend_t backend = ggml_backend_cpu_init();
    if (!backend) throw std::runtime_error("cpu_backend_failed");
    emit_ready();

    std::string request_id;
    std::string language = "auto";
    std::vector<int16_t> pcm;
    while (true) {
      unsigned char length_bytes[4];
      if (!read_exact(reinterpret_cast<char*>(length_bytes), sizeof(length_bytes))) break;
      const uint32_t length = read_be32(length_bytes);
      if (length < 1 || length > MAX_PCM_BYTES + 1) {
        emit_error(request_id, "invalid_frame", "frame length exceeds protocol limit");
        break;
      }
      std::vector<unsigned char> body(length);
      if (!read_exact(reinterpret_cast<char*>(body.data()), body.size())) break;
      const auto type = static_cast<FrameType>(body[0]);
      const std::string control(body.begin() + 1, body.end());

      try {
        if (type == BEGIN) {
          if (!request_id.empty()) throw std::runtime_error("session_already_active");
          request_id = json_string(control, "requestId");
          language = json_string(control, "language");
          if (request_id.empty()) throw std::runtime_error("missing_request_id");
          if (language.empty()) language = "auto";
          pcm.clear();
        } else if (type == AUDIO) {
          if (request_id.empty()) throw std::runtime_error("audio_without_begin");
          const size_t audio_bytes = body.size() - 1;
          if (audio_bytes % 2 != 0 || (pcm.size() * 2 + audio_bytes) > MAX_PCM_BYTES) {
            throw std::runtime_error("invalid_or_too_long_pcm16");
          }
          const size_t old_size = pcm.size();
          pcm.resize(old_size + audio_bytes / 2);
          for (size_t i = 0; i < audio_bytes / 2; ++i) {
            const uint16_t low = body[1 + i * 2];
            const uint16_t high = body[2 + i * 2];
            pcm[old_size + i] = static_cast<int16_t>((high << 8) | low);
          }
        } else if (type == END) {
          const std::string end_id = json_string(control, "requestId");
          if (request_id.empty() || end_id != request_id) throw std::runtime_error("end_request_id_mismatch");
          const std::string text = infer(model, backend, pcm, language);
          std::cout << "{\"type\":\"final\",\"requestId\":\"" << json_escape(request_id)
                    << "\",\"text\":\"" << json_escape(text) << "\"}" << std::endl;
          request_id.clear();
          pcm.clear();
        } else if (type == CANCEL) {
          const std::string cancel_id = json_string(control, "requestId");
          if (!request_id.empty() && cancel_id == request_id) {
            std::cout << "{\"type\":\"cancelled\",\"requestId\":\"" << json_escape(request_id) << "\"}" << std::endl;
            request_id.clear();
            pcm.clear();
          }
        } else if (type == SHUTDOWN) {
          break;
        } else {
          throw std::runtime_error("unknown_frame_type");
        }
      } catch (const std::exception& error) {
        emit_error(request_id, "request_failed", error.what());
        request_id.clear();
        pcm.clear();
      }
    }
    ggml_backend_free(backend);
    if (model.weights) ggml_free(model.weights);
    return 0;
  } catch (const std::exception& error) {
    emit_error("", "startup_failed", error.what());
    return 1;
  }
}
