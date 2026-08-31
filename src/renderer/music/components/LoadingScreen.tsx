import React from 'react';
import './LoadingScreen.css';
import loadingLogo from '../assets/logo.png';

const LoadingScreen: React.FC = () => {
  return (
    <div className="loading-screen">
      <div className="loading-card">
        <img
          className="loading-logo"
          src={loadingLogo}
          alt="loading"
        />
        <div className="loader">
          <div className="loader__circle" />
          <div className="loader__circle" />
          <div className="loader__circle" />
          <div className="loader__circle" />
          <div className="loader__circle" />
        </div>
      </div>
    </div>
  );
};

export default LoadingScreen;
