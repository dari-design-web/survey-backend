{ pkgs }: {
  deps = [
    pkgs.python311
    pkgs.python311Packages.pip
    pkgs.zlib
    pkgs.libjpeg
    pkgs.freetype
  ];
}
