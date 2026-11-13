'use client';
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, LoaderCircle } from 'lucide-react';
import { labClientAuth } from '@/lib/client-auth';
import { bannerReference } from '@/lib/banner';
import { prepareBanner } from '@/lib/banner-client';

export function CampaignBanner({
  path,
  enabled,
  onChange,
  onPreview,
  onBusyChange,
}: {
  path: string;
  enabled: boolean;
  onChange: (path: string) => void;
  onPreview: (url: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const revision = useRef(0);
  const currentUrl = useRef('');
  const previewCallback = useRef(onPreview);
  previewCallback.current = onPreview;
  // The wizard owns URL cleanup so the preview survives changes between steps.
  function show(url: string) {
    currentUrl.current = url;
    setPreview(url);
    previewCallback.current(url);
  }
  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );
  useEffect(() => {
    const reference = bannerReference(path);
    if (!reference || currentUrl.current) return;
    const request = revision.current;
    let active = true;
    void (async () => {
      const user = labClientAuth().currentUser;
      if (!user || user.uid !== reference.uid) return;
      const response = await fetch(`/api/account/banners/${reference.id}`, {
        headers: { Authorization: `Bearer ${await user.getIdToken()}` },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('The saved banner could not be loaded.');
      const blob = await response.blob();
      if (active && request === revision.current) show(URL.createObjectURL(blob));
    })().catch((e) => {
      if (active && request === revision.current) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <div className="campaign-banner-field">
      <label className="upload-field" aria-busy={uploading}>
        {preview ? (
          <img className="banner-thumbnail" src={preview} alt="Selected promotional banner" />
        ) : (
          <ImagePlus size={26} />
        )}
        <div>
          <strong>
            {uploading
              ? 'Saving banner…'
              : path
                ? 'Banner saved'
                : preview
                  ? 'Image preview'
                  : 'Choose a promotional banner'}
          </strong>
          <small>PNG or JPEG, up to 5 MB. Optimized securely before saving.</small>
        </div>
        {uploading && <LoaderCircle className="spin" size={20} />}
        <input
          aria-label="Upload promotional banner"
          type="file"
          accept="image/png,image/jpeg"
          disabled={!enabled || uploading}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const request = ++revision.current;
            setUploading(true);
            onBusyChange(true);
            setError('');
            try {
              const blob = await prepareBanner(file);
              if (request !== revision.current) return;
              show(URL.createObjectURL(blob));
              onChange('');
              const user = labClientAuth().currentUser;
              if (!user) throw new Error('Sign in to save this banner.');
              const response = await fetch('/api/account/banners', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${await user.getIdToken()}`,
                  'Content-Type': blob.type,
                  'X-Banner-Name': encodeURIComponent(file.name),
                },
                body: blob,
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || 'Unable to save banner.');
              if (request === revision.current) onChange(result.path);
            } catch (e) {
              if (request === revision.current)
                setError(e instanceof Error ? e.message : 'Unable to upload the banner.');
            } finally {
              if (request === revision.current) {
                setUploading(false);
                onBusyChange(false);
              }
            }
          }}
        />
      </label>
      {preview && (
        <div className="banner-preview">
          <img src={preview} alt="Promotional banner preview" />
          <button
            type="button"
            className="text-button"
            disabled={uploading}
            onClick={() => {
              revision.current++;
              show('');
              onChange('');
              setError('');
            }}
          >
            Remove image
          </button>
        </div>
      )}
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
