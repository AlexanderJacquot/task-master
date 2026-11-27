# Included by whisper.cpp's CMake build after each project() call (CMAKE_PROJECT_INCLUDE
# in config.toml). Only does something with MSVC.
#
# With the Visual Studio generator, the `cmake` crate passes CMAKE_<LANG>_FLAGS_<CONFIG>
# itself, to carry /MT or /MD: the `cc` crate's flags with every /O flag left out. That
# replaces CMake's own flags for the configuration (`/O2 /Ob2 /DNDEBUG` in Release), so
# MSVC compiled whisper.cpp and ggml with no optimization at all (its default is /Od) and
# with assert() on. v0.31.0 shipped that way: large-v3-turbo took 847 s for 33 s of speech.
# Put CMake's defaults back.
if(MSVC)
  foreach(lang C CXX)
    if(NOT "${CMAKE_${lang}_FLAGS_RELEASE}" MATCHES "[-/]O[12x]")
      string(APPEND CMAKE_${lang}_FLAGS_RELEASE " /O2 /Ob2 /DNDEBUG")
    endif()
    # Debug builds of the app: whisper-rs-sys asks for RelWithDebInfo.
    if(NOT "${CMAKE_${lang}_FLAGS_RELWITHDEBINFO}" MATCHES "[-/]O[12x]")
      string(APPEND CMAKE_${lang}_FLAGS_RELWITHDEBINFO " /O2 /Ob1 /DNDEBUG")
    endif()
  endforeach()
endif()
