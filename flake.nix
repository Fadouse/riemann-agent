{
  description = "Fadouse Riemann Agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      runtimePath = pkgs.lib.makeBinPath [
        pkgs.bubblewrap
        pkgs.uv
        pkgs.python311
      ];
      riemannAgent = pkgs.buildNpmPackage {
        pname = "riemann-agent";
        version = "0.85.0-git-${self.shortRev or "dirty"}";
        src = ./.;
        nodejs = pkgs.nodejs_24;
        npmDepsFetcherVersion = 2;
        npmDepsHash = "sha256-YPu4qEmGQB0j06IXPxlVgljZ53qxzJS/EzPbP725qlg=";
        npmFlags = [ "--ignore-scripts" ];
        npmBuildScript = "build:offline";
        nativeBuildInputs = [ pkgs.makeWrapper ];
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --ignore-scripts --no-audit --no-fund
          root="$out/libexec/riemann-agent"
          mkdir -p "$root" "$out/bin"
          cp -R package.json package-lock.json node_modules packages "$root/"
          makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/riemann" \
            --add-flags "$root/packages/coding-agent/dist/cli.js" \
            --set RIEMANN_PACKAGE_DIR "$root/packages/coding-agent" \
            --set RIEMANN_PYTHON ${pkgs.python311}/bin/python3 \
            --set RIEMANN_BWRAP_PATH ${pkgs.bubblewrap}/bin/bwrap \
            --prefix PATH : ${runtimePath}
          runHook postInstall
        '';
        dontStrip = true;
        meta = {
          description = "Fadouse Riemann software-engineering and research agent";
          homepage = "https://github.com/Fadouse/riemann-agent";
          license = pkgs.lib.licenses.mit;
          mainProgram = "riemann";
          platforms = [ "x86_64-linux" ];
        };
      };
    in
    {
      packages.${system} = {
        riemann-agent = riemannAgent;
        default = riemannAgent;
      };
      checks.${system}.riemann-agent = riemannAgent;
      formatter.${system} = pkgs.nixfmt;
    };
}
