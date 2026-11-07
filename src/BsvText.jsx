import React from 'react';

const BSV_TICKER = /(\bBSV\b(?!-))/g;

export default function BsvText({ children }) {
  if (typeof children !== 'string') return <>{children}</>;
  return <>{children.split(BSV_TICKER).map((part, index) => part === 'BSV' ? <span className="bsv-ticker" key={index}>BSV</span> : part)}</>;
}
