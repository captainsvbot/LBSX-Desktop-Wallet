import React, { useEffect, useState } from 'react';

export default function TokenIcon({ token, fallback }) {
  const [image, setImage] = useState({ key: '', src: '' });
  const tokenId = token?.tokenId || '';
  const icon = token?.icon || '';
  const requestKey = `${tokenId}:${icon}`;

  useEffect(() => {
    let active = true;
    setImage({ key: requestKey, src: '' });
    if (!tokenId || !icon || typeof window.lbsx?.getTokenIcon !== 'function') return () => { active = false; };
    window.lbsx.getTokenIcon({ tokenId, icon }).then(src => {
      if (active) setImage({ key: requestKey, src: typeof src === 'string' ? src : '' });
    }).catch(() => {
      if (active) setImage({ key: requestKey, src: '' });
    });
    return () => { active = false; };
  }, [tokenId, icon, requestKey]);

  const src = image.key === requestKey ? image.src : '';
  return src
    ? <img className="token-image" src={src} alt={`${token?.symbol || 'Token'} icon`} onError={() => setImage({ key: requestKey, src: '' })} />
    : <span className="token-image-fallback">{fallback || token?.symbol?.slice(0, 1).toUpperCase() || '?'}</span>;
}
