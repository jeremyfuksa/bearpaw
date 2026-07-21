import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportProgressOverlay } from '../ImportProgressOverlay';

describe('ImportProgressOverlay', () => {
  it('renders nothing when inactive', () => {
    render(<ImportProgressOverlay active={false} percent={0} message="" />);
    expect(screen.queryByText('Importing')).not.toBeInTheDocument();
  });

  it('shows percent and message when active', () => {
    render(<ImportProgressOverlay active percent={42.6} message="Importing 213/500" />);
    expect(screen.getByText('Importing')).toBeInTheDocument();
    expect(screen.getByText('43%')).toBeInTheDocument(); // rounded
    expect(screen.getByText('Importing 213/500')).toBeInTheDocument();
  });

  it('falls back to a default message when none is given', () => {
    render(<ImportProgressOverlay active percent={0} message="" />);
    expect(screen.getByText('Writing to scanner…')).toBeInTheDocument();
  });
});
