cmake_minimum_required(VERSION 3.16)
project(cortex-sensevoice-sidecar LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

if(MSVC)
  add_compile_definitions(NOMINMAX _USE_MATH_DEFINES)
endif()

# 与 FunASR runtime-llamacpp-v0.1.9 使用相同的 llama.cpp 提交，保证 GGUF/ggml ABI 可复现。
include(FetchContent)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
# 发布流水线可能在 Apple Silicon runner 交叉编译 Intel 包；禁止 `-march=native`，否则
# clang 会把宿主的 apple-m3 当成 x86 CPU 名并直接失败。该设置也让产物可运行在较老 CPU。
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  llama
  GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
  GIT_TAG 8086439a4cea94c71a5dfb8fe4ad1546aebd640f
)
FetchContent_MakeAvailable(llama)

add_executable(cortex-sensevoice-sidecar sensevoice-sidecar.cpp)
target_link_libraries(cortex-sensevoice-sidecar PRIVATE ggml)
