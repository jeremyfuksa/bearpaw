import svgPaths from "./svg-govmzsdb93";

function Scan() {
  return (
    <div className="content-stretch flex flex-col items-center justify-center px-[12px] py-[4px] relative shrink-0" data-name="Scan">
      <div aria-hidden="true" className="absolute border-[0px_0px_2px] border-[rgba(217,119,6,0.5)] border-solid inset-0 pointer-events-none" />
      <p className="font-bold relative shrink-0 text-xs text-nowrap text-white">Scan</p>
    </div>
  );
}

function Scan1() {
  return (
    <div className="content-stretch flex flex-col items-center justify-center px-[12px] py-[4px] relative shrink-0" data-name="Scan">
      <p className="font-semibold relative shrink-0 text-[#f5ebe8] text-xs text-nowrap">Device</p>
    </div>
  );
}

function Scan2() {
  return (
    <div className="content-stretch flex flex-col items-center justify-center px-[12px] py-[4px] relative shrink-0" data-name="Scan">
      <p className="font-semibold relative shrink-0 text-[#f5ebe8] text-xs text-nowrap">Channels</p>
    </div>
  );
}

function TabNav() {
  return (
    <div className="content-stretch flex gap-[16px] items-start pb-px pt-0 px-0 relative shrink-0 w-full" data-name="Tab Nav">
      <div aria-hidden="true" className="absolute border-[#1c1f26] border-[0px_0px_1px] border-solid inset-0 pointer-events-none" />
      <Scan />
      <Scan1 />
      <Scan2 />
    </div>
  );
}

function Status() {
  return (
    <div className="content-stretch flex gap-[8px] items-center relative shrink-0" data-name="Status">
      <div className="relative shrink-0 size-[8px]" data-name="Status LED">
        <svg className="block size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 8 8">
          <circle cx="4" cy="4" fill="var(--fill-0, #67E79E)" id="Status LED" r="4" />
        </svg>
      </div>
      <p className="font-normal leading-[normal] relative shrink-0 text-[#f5ebe8] text-xs text-nowrap">BC125AT</p>
    </div>
  );
}

function Vol() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="VOL">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">VOL</p>
    </div>
  );
}

function LO() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="L/O">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">L/O</p>
    </div>
  );
}

function Hold() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="HOLD">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">HOLD</p>
    </div>
  );
}

function Buttons() {
  return (
    <div className="content-stretch flex gap-[10px] items-center relative shrink-0" data-name="Buttons">
      <Vol />
      <LO />
      <Hold />
    </div>
  );
}

function Header() {
  return (
    <div className="content-stretch flex items-center justify-between relative shrink-0 w-full" data-name="Header">
      <Status />
      <Buttons />
    </div>
  );
}

function Signal() {
  return (
    <div className="absolute inset-[6.25%_0_5.82%_0]" data-name="signal">
      <svg className="block size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 16 14.0694">
        <g id="signal">
          <path d={svgPaths.p3025b700} fill="var(--fill-0, #1C1F27)" fillOpacity="0.9" id="Vector" />
          <path d={svgPaths.p31141000} fill="var(--fill-0, black)" id="Vector_2" />
          <path d={svgPaths.p30ee9a00} fill="var(--fill-0, black)" id="Vector_3" />
          <path d={svgPaths.pd4593f0} fill="var(--fill-0, black)" id="Vector_4" />
          <path d={svgPaths.p24eea280} fill="var(--fill-0, black)" id="Vector_5" />
          <path d={svgPaths.p1690cd00} fill="var(--fill-0, black)" id="Vector_6" />
          <path d={svgPaths.p45ef080} fill="var(--fill-0, black)" id="Vector_7" />
        </g>
      </svg>
    </div>
  );
}

function Status1() {
  return (
    <div className="overflow-clip relative shrink-0 size-[16px]" data-name="status">
      <Signal />
    </div>
  );
}

function MainContent() {
  return (
    <div className="content-stretch flex items-center justify-between pb-[4px] pt-0 px-0 relative shrink-0 w-full" data-name="Main Content">
      <div aria-hidden="true" className="absolute border-[0px_0px_1px] border-[rgba(43,48,59,0.7)] border-solid inset-0 pointer-events-none" />
      <p className="font-bold leading-[normal] relative shrink-0 text-2xl text-[rgba(28,31,39,0.9)] text-nowrap">ASH3D Flappy Fart</p>
      <Status1 />
    </div>
  );
}

function SecondaryContent() {
  return (
    <div className="content-stretch flex gap-[8px] items-start relative shrink-0 w-full" data-name="Secondary Content">
      <p className="font-normal leading-[normal] relative shrink-0 text-xs text-[rgba(28,31,39,0.9)] text-nowrap">444.525 • NFM • CH67</p>
    </div>
  );
}

function Display() {
  return (
    <div className="relative rounded-[6px] shrink-0 w-[291px]" data-name="Display" style={{ backgroundImage: "url('data:image/svg+xml;utf8,<svg viewBox=\\\'0 0 291 81\\\' xmlns=\\\'http://www.w3.org/2000/svg\\\' preserveAspectRatio=\\\'none\\\'><rect x=\\\'0\\\' y=\\\'0\\\' height=\\\'100%\\\' width=\\\'100%\\\' fill=\\\'url(%23grad)\\\' opacity=\\\'1\\\'/><defs><radialGradient id=\\\'grad\\\' gradientUnits=\\\'userSpaceOnUse\\\' cx=\\\'0\\\' cy=\\\'0\\\' r=\\\'10\\\' gradientTransform=\\\'matrix(14.55 0 0 4.05 145.5 40.5)\\\'><stop stop-color=\\\'rgba(239,153,31,1)\\\' offset=\\\'0\\\'/><stop stop-color=\\\'rgba(228,136,19,1)\\\' offset=\\\'0.5\\\'/><stop stop-color=\\\'rgba(217,119,6,1)\\\' offset=\\\'1\\\'/></radialGradient></defs></svg>')" }}>
      <div className="content-stretch flex flex-col gap-[8px] items-start overflow-clip px-[12px] py-[10px] relative rounded-[inherit] w-full">
        <MainContent />
        <SecondaryContent />
      </div>
      <div className="absolute inset-[-1px] pointer-events-none shadow-[inset_4px_4px_4px_0px_#b06105]" />
      <div aria-hidden="true" className="absolute border border-[#1e2024] border-solid inset-[-1px] pointer-events-none rounded-[7px]" />
    </div>
  );
}

function Component() {
  return (
    <div className="bg-[rgba(43,48,59,0.5)] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shrink-0" data-name="1">
      <div aria-hidden="true" className="absolute border border-[#ef991f] border-solid inset-0 pointer-events-none rounded-[2px]" />
      <p className="font-medium relative shrink-0 text-[#ef991f] text-xs text-nowrap">1</p>
    </div>
  );
}

function Component1() {
  return (
    <div className="bg-[rgba(43,48,59,0.5)] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shrink-0" data-name="2">
      <div aria-hidden="true" className="absolute border border-[#ef991f] border-solid inset-0 pointer-events-none rounded-[2px]" />
      <p className="font-medium relative shrink-0 text-[#ef991f] text-xs text-nowrap">2</p>
    </div>
  );
}

function Component2() {
  return (
    <div className="bg-[rgba(43,48,59,0.5)] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shrink-0" data-name="3">
      <div aria-hidden="true" className="absolute border border-[#ef991f] border-solid inset-0 pointer-events-none rounded-[2px]" />
      <p className="font-medium relative shrink-0 text-[#ef991f] text-xs text-nowrap">3</p>
    </div>
  );
}

function Component3() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="4">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">4</p>
    </div>
  );
}

function Component4() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="5">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">5</p>
    </div>
  );
}

function Component5() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="6">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">6</p>
    </div>
  );
}

function Component6() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="7">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">7</p>
    </div>
  );
}

function Component7() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="8">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">8</p>
    </div>
  );
}

function Component8() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="9">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">9</p>
    </div>
  );
}

function Component9() {
  return (
    <div className="bg-[#4c627d] content-stretch flex items-center justify-center px-[4px] py-[2px] relative rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0" data-name="10">
      <p className="font-medium relative shrink-0 text-[#acbbcc] text-xs text-nowrap">0</p>
    </div>
  );
}

function ControlButtons() {
  return (
    <div className="basis-0 content-stretch flex gap-[16px] grow items-start min-h-px min-w-px relative shrink-0" data-name="Control Buttons">
      <Component />
      <Component1 />
      <Component2 />
      <Component3 />
      <Component4 />
      <Component5 />
      <Component6 />
      <Component7 />
      <Component8 />
      <Component9 />
    </div>
  );
}

function Controls() {
  return (
    <div className="content-stretch flex items-center justify-end relative shrink-0 w-full" data-name="Controls">
      <ControlButtons />
    </div>
  );
}

function ScanControl() {
  return (
    <div className="content-stretch flex flex-col gap-[8px] items-start relative shrink-0" data-name="Scan Control">
      <Header />
      <Display />
      <Controls />
    </div>
  );
}

function Subhead() {
  return (
    <div className="h-[17px] relative shrink-0 w-full" data-name="Subhead">
      <p className="absolute font-bold leading-[normal] left-0 not-italic text-[#f5ebe8] text-base text-nowrap top-0">Recent Hits</p>
    </div>
  );
}

function Frequency() {
  return (
    <div className="h-[12px] relative shrink-0 w-[45px]" data-name="Frequency">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">157.1000</p>
    </div>
  );
}

function Tag() {
  return (
    <div className="h-[12px] relative shrink-0 w-[69px]" data-name="Tag">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">Marine CH22</p>
    </div>
  );
}

function HitRow() {
  return (
    <div className="content-stretch flex gap-[18px] items-start relative shrink-0 w-full" data-name="Hit Row">
      <Frequency />
      <Tag />
    </div>
  );
}

function Frequency1() {
  return (
    <div className="h-[12px] relative shrink-0 w-[45px]" data-name="Frequency">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">160.2500</p>
    </div>
  );
}

function Tag1() {
  return (
    <div className="h-[12px] relative shrink-0 w-[69px]" data-name="Tag">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">DX Enthusiast</p>
    </div>
  );
}

function HitRow1() {
  return (
    <div className="content-stretch flex gap-[18px] items-start relative shrink-0 w-full" data-name="Hit Row">
      <Frequency1 />
      <Tag1 />
    </div>
  );
}

function Frequency2() {
  return (
    <div className="h-[12px] relative shrink-0 w-[45px]" data-name="Frequency">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">146.5200</p>
    </div>
  );
}

function Tag2() {
  return (
    <div className="h-[12px] relative shrink-0 w-[69px]" data-name="Tag">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">W0TE</p>
    </div>
  );
}

function HitRow2() {
  return (
    <div className="content-stretch flex gap-[18px] items-start relative shrink-0 w-full" data-name="Hit Row">
      <Frequency2 />
      <Tag2 />
    </div>
  );
}

function Frequency3() {
  return (
    <div className="h-[12px] relative shrink-0 w-[45px]" data-name="Frequency">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">145.8000</p>
    </div>
  );
}

function Tag3() {
  return (
    <div className="h-[12px] relative shrink-0 w-[69px]" data-name="Tag">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">CB Super Bowl</p>
    </div>
  );
}

function HitRow3() {
  return (
    <div className="content-stretch flex gap-[18px] items-start relative shrink-0 w-full" data-name="Hit Row">
      <Frequency3 />
      <Tag3 />
    </div>
  );
}

function Frequency4() {
  return (
    <div className="h-[12px] relative shrink-0 w-[45px]" data-name="Frequency">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">144.3900</p>
    </div>
  );
}

function Tag4() {
  return (
    <div className="h-[12px] relative shrink-0 w-[69px]" data-name="Tag">
      <p className="absolute font-normal leading-[normal] left-0 not-italic text-[#f5ebe8] text-xs text-nowrap top-0">Weak Signal</p>
    </div>
  );
}

function HitRow4() {
  return (
    <div className="content-stretch flex gap-[18px] items-start relative shrink-0 w-full" data-name="Hit Row">
      <Frequency4 />
      <Tag4 />
    </div>
  );
}

function HitTable() {
  return (
    <div className="content-stretch flex flex-col gap-[6px] items-start opacity-80 relative shrink-0 w-full" data-name="Hit Table">
      <HitRow />
      <HitRow1 />
      <HitRow2 />
      <HitRow3 />
      <HitRow4 />
    </div>
  );
}

function RecentHits() {
  return (
    <div className="content-stretch flex flex-col gap-[12px] items-start relative shrink-0 w-[148px]" data-name="Recent Hits">
      <Subhead />
      <HitTable />
    </div>
  );
}

function Ui() {
  return (
    <div className="content-stretch flex gap-[24px] items-start relative shrink-0" data-name="UI">
      <ScanControl />
      <RecentHits />
    </div>
  );
}

export default function ScanHit() {
  return (
    <div className="content-stretch flex flex-col gap-[16px] items-start p-[24px] relative size-full" data-name="Scan Hit" style={{ backgroundImage: "url('data:image/svg+xml;utf8,<svg viewBox=\\\'0 0 511 217\\\' xmlns=\\\'http://www.w3.org/2000/svg\\\' preserveAspectRatio=\\\'none\\\'><rect x=\\\'0\\\' y=\\\'0\\\' height=\\\'100%\\\' width=\\\'100%\\\' fill=\\\'url(%23grad)\\\' opacity=\\\'1\\\'/><defs><radialGradient id=\\\'grad\\\' gradientUnits=\\\'userSpaceOnUse\\\' cx=\\\'0\\\' cy=\\\'0\\\' r=\\\'10\\\' gradientTransform=\\\'matrix(-2.2512e-14 14.305 -33.685 8.0487e-15 255.5 49.662)\\\'><stop stop-color=\\\'rgba(61,68,84,1)\\\' offset=\\\'0\\\'/><stop stop-color=\\\'rgba(45,50,61,1)\\\' offset=\\\'0.5\\\'/><stop stop-color=\\\'rgba(28,31,38,1)\\\' offset=\\\'1\\\'/></radialGradient></defs></svg>')" }}>
      <TabNav />
      <Ui />
    </div>
  );
}